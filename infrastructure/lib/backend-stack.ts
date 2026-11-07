import { CustomResource, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { DatabaseCluster } from 'aws-cdk-lib/aws-rds';
import { ISecurityGroup, IVpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Construct } from 'constructs';
import { calculateMigrationBundleHash, migrationPaths } from './migration-assets';

export interface BackendStackProps extends StackProps {
  readonly databaseCluster: DatabaseCluster;
  readonly vpc: IVpc;
  readonly applicationSecurityGroup: ISecurityGroup;
  readonly rawDataBucket: IBucket;
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

    const adjacentProjectRoot = join(__dirname, '..');
    const projectRoot = existsSync(join(adjacentProjectRoot, 'lambda', 'migration', 'migrations'))
      ? adjacentProjectRoot
      : join(adjacentProjectRoot, '..');
    const paths = migrationPaths(projectRoot);
    const migrationBundleHash = calculateMigrationBundleHash(paths.root);

    const commentDeadLetterQueue = new Queue(this, 'CommentDeadLetterQueue', {
      queueName: `${resourceNamePrefix}-comment-dlq`,
      retentionPeriod: Duration.days(14),
      encryption: QueueEncryption.SQS_MANAGED,
    });
    const commentQueue = new Queue(this, 'CommentQueue', {
      queueName: `${resourceNamePrefix}-comment-queue`,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(360),
      encryption: QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: commentDeadLetterQueue, maxReceiveCount: 5 },
    });

    const dataCollectorFunctionName = `${resourceNamePrefix}-data-collector`;
    const dataCollectorLogGroup = new LogGroup(this, 'DataCollectorLogGroup', {
      logGroupName: `/aws/lambda/${dataCollectorFunctionName}`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const dataCollectorRole = new Role(this, 'DataCollectorRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      roleName: dataCollectorFunctionName,
    });
    dataCollectorRole.addToPolicy(new PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`${dataCollectorLogGroup.logGroupArn}:*`],
    }));
    dataCollectorRole.addToPolicy(new PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: [props.rawDataBucket.arnForObjects('outbox/*')],
    }));
    dataCollectorRole.addToPolicy(new PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [props.rawDataBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': ['outbox/*'] } },
    }));
    dataCollectorRole.addToPolicy(new PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: [commentQueue.queueArn],
    }));
    const youtubeApiKeyParameterName = `/stream-insight/${environment}/youtube/api-key`;
    dataCollectorRole.addToPolicy(new PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [this.formatArn({
        service: 'ssm',
        resource: 'parameter',
        resourceName: `stream-insight/${environment}/youtube/api-key`,
      })],
    }));

    const dataCollectorFunction = new NodejsFunction(this, 'DataCollectorFunction', {
      functionName: dataCollectorFunctionName,
      entry: join(projectRoot, 'lambda', 'data-collector', 'handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      memorySize: 512,
      timeout: Duration.seconds(60),
      reservedConcurrentExecutions: 2,
      role: dataCollectorRole,
      logGroup: dataCollectorLogGroup,
      environment: {
        RAW_DATA_BUCKET_NAME: props.rawDataBucket.bucketName,
        COMMENT_QUEUE_URL: commentQueue.queueUrl,
        YOUTUBE_AUTH_MODE: 'API_KEY',
        YOUTUBE_API_KEY_PARAMETER_NAME: youtubeApiKeyParameterName,
        MAX_MESSAGE_BODY_BYTES: '921600',
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
      },
    });
    dataCollectorFunction.node.addDependency(dataCollectorLogGroup);

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

    const databaseMigration = new CustomResource(this, 'DatabaseMigration', {
      resourceType: 'Custom::DatabaseMigration',
      serviceToken: migrationFunction.functionArn,
      serviceTimeout: Duration.seconds(330),
      properties: {
        MigrationBundleHash: migrationBundleHash,
      },
    });

    const streamMetadataFunctionName = `${resourceNamePrefix}-stream-metadata`;
    const streamMetadataLogGroup = new LogGroup(this, 'StreamMetadataLogGroup', {
      logGroupName: `/aws/lambda/${streamMetadataFunctionName}`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const streamMetadataRole = new Role(this, 'StreamMetadataRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      roleName: streamMetadataFunctionName,
    });
    streamMetadataRole.addToPolicy(new PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`${streamMetadataLogGroup.logGroupArn}:*`],
    }));
    streamMetadataRole.addToPolicy(new PolicyStatement({
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeSubnets',
        'ec2:DeleteNetworkInterface',
        'ec2:AssignPrivateIpAddresses',
        'ec2:UnassignPrivateIpAddresses',
      ],
      resources: ['*'],
    }));

    const streamMetadataFunction = new NodejsFunction(this, 'StreamMetadataFunction', {
      functionName: streamMetadataFunctionName,
      entry: join(projectRoot, 'lambda', 'stream-metadata', 'handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      memorySize: 256,
      timeout: Duration.seconds(60),
      reservedConcurrentExecutions: 1,
      role: streamMetadataRole,
      logGroup: streamMetadataLogGroup,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.applicationSecurityGroup],
      environment: {
        DB_HOST: props.databaseCluster.clusterEndpoint.hostname,
        DB_PORT: props.databaseCluster.clusterEndpoint.port.toString(),
        DB_NAME: 'stream_insight',
        DB_USER: 'stream_metadata_user',
        RDS_CA_BUNDLE_PATH: '/var/task/assets/global-bundle.pem',
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
          afterBundling: (_inputDir, outputDir) => [
            `node "${paths.copyScript}" "${join(projectRoot, 'lambda', 'stream-metadata', 'assets', 'global-bundle.pem')}" "${join(outputDir, 'assets', 'global-bundle.pem')}"`,
          ],
        },
      },
    });
    streamMetadataFunction.node.addDependency(streamMetadataLogGroup);
    streamMetadataFunction.node.addDependency(databaseMigration);
    props.databaseCluster.grantConnect(streamMetadataFunction, 'stream_metadata_user');
    props.databaseCluster.connections.allowDefaultPortFrom(props.applicationSecurityGroup);
  }
}
