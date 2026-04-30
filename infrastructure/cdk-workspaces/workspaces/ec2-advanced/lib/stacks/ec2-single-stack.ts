import * as cdk from "aws-cdk-lib";
import { aws_ec2 as ec2, aws_sns as sns } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Environment } from "@common/parameters/environments";
import { VpcConstruct } from "@common/constructs/vpc/vpc";
import { Ec2Config } from "parameters/environments";
import { Ec2Single } from "lib/constructs/ec2-single";

export interface Ec2SingleStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly vpc: VpcConstruct;
  readonly ec2Config?: Ec2Config;
  readonly notificationTopic?: sns.ITopic;
}

/**
 * EC2 Single Stack
 *
 * Deploys a single EC2 instance in a private subnet.
 * Access via SSM Session Manager (no SSH / no public IP needed).
 * No load balancer.
 */
export class Ec2SingleStack extends cdk.Stack {
  public readonly ec2: Ec2Single;

  constructor(scope: Construct, id: string, props: Ec2SingleStackProps) {
    super(scope, id, props);

    const securityGroup = new ec2.SecurityGroup(this, "Ec2SecurityGroup", {
      vpc: props.vpc.vpc,
      description: "EC2 Single - allow outbound only (SSM via VPC endpoint or NAT)",
      allowAllOutbound: true,
    });

    this.ec2 = new Ec2Single(this, "Ec2Single", {
      project: props.project,
      environment: props.environment,
      vpc: props.vpc.vpc,
      securityGroup,
      instanceType:
        props.ec2Config?.instanceType ??
        ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        edition: ec2.AmazonLinuxEdition.STANDARD,
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      rootVolumeSize: props.ec2Config?.rootVolumeSize,
      additionalUserData: props.ec2Config?.additionalUserData,
      notificationTopic: props.notificationTopic,
    });
  }
}
