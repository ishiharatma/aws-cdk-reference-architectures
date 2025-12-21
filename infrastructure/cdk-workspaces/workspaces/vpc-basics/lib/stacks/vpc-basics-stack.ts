import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as logs from "aws-cdk-lib/aws-logs";
import { Environment } from "@common/parameters/environments";
import { pascalCase } from "change-case-commonjs";

export interface StackProps extends cdk.StackProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
}

export class VpcBasicsStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Create a VPC with custom settings
    const vpcName = [
      pascalCase(props.project), // project name
      pascalCase(props.environment), // environment identifier
      "CustomVPC", // purpose
    ]
      .join("/");

    const customVpc = new ec2.Vpc(this, "CustomVPC", {
      vpcName,
      ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
      maxAzs: 3, // maximum number of AZs to use
      //availabilityZones: ['ap-northeast-1a', 'ap-northeast-1c', 'ap-northeast-1d'], // specify AZs
      natGateways: 1, // number of NAT Gateways
      subnetConfiguration: [
        {
          cidrMask: 26, // 64 IPs per AZ
          name: 'External',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 27, // 32 IPs per AZ
          name: 'Management',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 22, // 1024 IPs per AZ
          name: 'Internal',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 22, // 1024 IPs per AZ
          name: 'Application',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24, // 256 IPs per AZ
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        {
          cidrMask: 28, // 16 IPs per AZ
          name: 'TransitGateway',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ],
    });
    this.vpc = customVpc;
    // add Flow Logs exporting to S3
    const flowLogBucket = new s3.Bucket(this, "FlowLogBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // NOT recommended for production use
      autoDeleteObjects: true, // NOT recommended for production use
    });
    
    customVpc.addFlowLog("FlowLogToS3", {
      destination: ec2.FlowLogDestination.toS3(
        flowLogBucket,
        'vpcFlowLog/',
        {
          fileFormat: ec2.FlowLogFileFormat.PLAIN_TEXT,
          hiveCompatiblePartitions: true,
          perHourPartition: true,
        }
      ),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });
    // add Flow Logs exporting to CloudWatch Logs
    // Only reject traffic
    customVpc.addFlowLog("FlowLog", {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, "FlowLogGroup", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        })
      ),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });

    const endpointSubnets = customVpc.selectSubnets({
      subnetGroupName: 'Internal',
    });
    if (endpointSubnets.subnets.length === 0) {
      throw new Error('No subnets found for subnet group "Internal"');
    }
    // Gateway Endpoints
    // see: https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html
    // add VPC Gateway Endpoint for S3
    customVpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnets: endpointSubnets.subnets }],
    });
    // add VPC Endpoint for DynamoDB
    customVpc.addGatewayEndpoint("DynamoDbEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      subnets: [{ subnets: endpointSubnets.subnets }],
    });

    // Interface Endpoints
    // for Systems Manager
    // see: https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-create-vpc.html#create-vpc-endpoints
    customVpc.addInterfaceEndpoint("SSMEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: {
        subnets: endpointSubnets.subnets,
      },
    });
    customVpc.addInterfaceEndpoint("SSMMessagesEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      subnets: {
        subnets: endpointSubnets.subnets,
      },
    });
    // SSM Agent version 3.3.40 or later is not required
    /*
    customVpc.addInterfaceEndpoint("EC2MessagesEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      subnets: {
        subnets: endpointSubnets.subnets,
      },
    });
    */

    // for Instance Connect Endpoint
    // see: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-with-ec2-instance-connect-endpoint.html
    const ec2InstanceConnectsg = new ec2.SecurityGroup(this, "EC2InstanceConnectSG", {
      vpc: customVpc,
      description: "Security group for EC2 Instance Connect Endpoint",
      allowAllOutbound: false,
    });

    // Instance Connect Endpoint in the first InternalSubnet
    // Because Maximum number of EC2 Instance Connect Endpoints per VPC is 1
    // see: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/eice-quotas.html
    const iceSubnet = endpointSubnets.subnets[0];
    new ec2.CfnInstanceConnectEndpoint(this, "EC2InstanceConnectEndpoint", {
      subnetId: iceSubnet.subnetId,
      preserveClientIp: false,
      securityGroupIds: [ec2InstanceConnectsg.securityGroupId],
    });

    const ec2sg = new ec2.SecurityGroup(this, "EC2SG", {
      vpc: customVpc,
      description: "Security group for EC2 instances",
      allowAllOutbound: true,
    });

    // Allow Instance Connect access with mutual security group references
    // Use CfnSecurityGroupIngress/Egress to avoid circular dependencies
    // ⚠️if use addIngressRule/addEgressRule, it will create circular dependency between the two security groups
    // Ingress: Instance Connect SG -> EC2 SG
    new ec2.CfnSecurityGroupIngress(this, "AllowSSHFromInstanceConnect", {
      ipProtocol: "tcp",
      fromPort: 22,
      toPort: 22,
      groupId: ec2sg.securityGroupId,
      sourceSecurityGroupId: ec2InstanceConnectsg.securityGroupId,
      description: "Allow SSH from Instance Connect SG",
    });
    // Egress: Instance Connect SG -> EC2 SG
    new ec2.CfnSecurityGroupEgress(this, "AllowSSHToEC2SG", {
      ipProtocol: "tcp",
      fromPort: 22,
      toPort: 22,
      groupId: ec2InstanceConnectsg.securityGroupId,
      destinationSecurityGroupId: ec2sg.securityGroupId,
      description: "Allow SSH to EC2 SG",
    });
    // Circular dependency can be avoided by using addIngressRule/addEgressRule, but it is commented out here
    /*
    ec2sg.addIngressRule(
      ec2.Peer.securityGroupId(ec2InstanceConnectsg.securityGroupId),
      ec2.Port.tcp(22),
      "Allow SSH from Instance Connect SG"
    );
    ec2InstanceConnectsg.addEgressRule(
      ec2.Peer.securityGroupId(ec2sg.securityGroupId),
      ec2.Port.tcp(22),
      "Allow SSH to EC2 SG"
    );
    */
  }
}
