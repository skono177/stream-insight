import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class StorageStack extends Stack {
  public readonly rawDataBucket: Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const environment = this.node.tryGetContext('environment') as string;

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
  }
}
