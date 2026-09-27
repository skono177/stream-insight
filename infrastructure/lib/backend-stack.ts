import { CustomResource, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { DatabaseCluster } from 'aws-cdk-lib/aws-rds';
import { join } from 'node:path';
import { Construct } from 'constructs';
import { calculateMigrationBundleHash, migrationPaths } from './migration-assets';

export interface BackendStackProps extends StackProps {
  readonly databaseCluster: DatabaseCluster;
}

export class BackendStack extends Stack {
  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    const environment = this.node.tryGetContext('environment') as string;
    const resourceNamePrefix = `stream-insight-${environment}`;
    const secret = props.databaseCluster.secret;
    if (!secret) {
      throw new Error('Aurora administrator secret is required for the Migration Lambda');
    }

    const projectRoot = join(__dirname, '..');
    const paths = migrationPaths(projectRoot);
    const migrationBundleHash = calculateMigrationBundleHash(paths.root);
    const functionName = `${resourceNamePrefix}-migration`;
    const logGroup = new LogGroup(this, 'MigrationLogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const role = new Role(this, 'MigrationRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      roleName: `${resourceNamePrefix}-migration`,
    });
    role.addToPolicy(
      new PolicyStatement({
        actions: [
          'rds-data:BeginTransaction',
          'rds-data:ExecuteStatement',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
        ],
        resources: [props.databaseCluster.clusterArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [secret.secretArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${logGroup.logGroupArn}:*`],
      }),
    );

    const migrationFunction = new NodejsFunction(this, 'MigrationFunction', {
      functionName,
      entry: join(projectRoot, 'lambda', 'migration', 'handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      memorySize: 256,
      timeout: Duration.seconds(300),
      reservedConcurrentExecutions: 1,
      role,
      logGroup,
      environment: {
        CLUSTER_ARN: props.databaseCluster.clusterArn,
        SECRET_ARN: secret.secretArn,
        DATABASE_NAME: 'stream_insight',
        ENVIRONMENT: environment,
        NODE_OPTIONS: '--enable-source-maps',
      },
      depsLockFilePath: join(projectRoot, 'package-lock.json'),
      projectRoot,
      bundling: {
        target: 'node24',
        format: OutputFormat.CJS,
        sourceMap: true,
        sourcesContent: false,
        bundleAwsSDK: true,
        commandHooks: {
          beforeInstall: () => [],
          beforeBundling: () => [],
          afterBundling: (inputDir, outputDir) => [
            `node "${paths.copyScript}" "${paths.root}" "${join(outputDir, 'migrations')}"`,
          ],
        },
      },
    });
    migrationFunction.node.addDependency(logGroup);

    new CustomResource(this, 'DatabaseMigration', {
      resourceType: 'Custom::DatabaseMigration',
      serviceToken: migrationFunction.functionArn,
      serviceTimeout: Duration.seconds(330),
      properties: {
        MigrationBundleHash: migrationBundleHash,
      },
    });
  }
}
