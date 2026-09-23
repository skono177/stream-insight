import { Stack, StackProps } from 'aws-cdk-lib';
import {
  GatewayVpcEndpoint,
  GatewayVpcEndpointAwsService,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends Stack {
  public readonly vpc: Vpc;
  public readonly applicationSecurityGroup: SecurityGroup;
  public readonly s3GatewayEndpoint: GatewayVpcEndpoint;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const environment = this.node.tryGetContext('environment') as string;
    const resourceNamePrefix = `stream-insight-${environment}`;

    this.vpc = new Vpc(this, 'Vpc', {
      vpcName: `${resourceNamePrefix}-vpc`,
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'private',
          subnetType: SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    this.s3GatewayEndpoint = this.vpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: SubnetType.PRIVATE_ISOLATED }],
    });

    this.applicationSecurityGroup = new SecurityGroup(this, 'ApplicationSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${resourceNamePrefix}-application`,
      description: 'Security group for Stream Insight application resources',
    });
  }
}
