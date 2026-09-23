import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { IVpc, SecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2';
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
} from 'aws-cdk-lib/aws-rds';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StorageStackProps extends StackProps {
  readonly vpc: IVpc;
}

export class StorageStack extends Stack {
  public readonly rawDataBucket: Bucket;
  public readonly databaseCluster: DatabaseCluster;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const environment = this.node.tryGetContext('environment') as string;
    const resourceNamePrefix = `stream-insight-${environment}`;

    this.rawDataBucket = new Bucket(this, 'RawDataBucket', {
      bucketName: `stream-insight-${environment}-raw-${this.account}`,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          id: 'DeleteAfter7Days',
          enabled: true,
          expiration: Duration.days(7),
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const auroraSecurityGroup = new SecurityGroup(this, 'AuroraSecurityGroup', {
      vpc: props.vpc,
      securityGroupName: `${resourceNamePrefix}-aurora`,
      description: 'Security group for Stream Insight Aurora PostgreSQL',
    });

    this.databaseCluster = new DatabaseCluster(this, 'DatabaseCluster', {
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_17_7,
      }),
      credentials: Credentials.fromGeneratedSecret('postgres', {
        secretName: `stream-insight/${environment}/aurora/admin`,
      }),
      writer: ClusterInstance.serverlessV2('Writer', {
        publiclyAccessible: false,
      }),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 2,
      serverlessV2AutoPauseDuration: Duration.minutes(5),
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [auroraSecurityGroup],
      defaultDatabaseName: 'stream_insight',
      port: 5432,
      iamAuthentication: true,
      enableDataApi: true,
      backup: {
        retention: Duration.days(1),
      },
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      deleteAutomatedBackups: true,
      storageEncrypted: true,
    });

    this.databaseCluster.secret?.applyRemovalPolicy(RemovalPolicy.DESTROY);
  }
}
