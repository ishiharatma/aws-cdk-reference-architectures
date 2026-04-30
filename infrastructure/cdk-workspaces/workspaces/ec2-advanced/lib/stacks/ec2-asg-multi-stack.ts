import * as cdk from "aws-cdk-lib";
import { aws_ec2 as ec2, aws_sns as sns } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Environment } from "@common/parameters/environments";
import { VpcConstruct } from "@common/constructs/vpc/vpc";
import { AlbConstruct } from "@common/constructs/alb";
import { Ec2Config } from "parameters/environments";
import { Ec2AsgMulti } from "lib/constructs/ec2-asg-multi";

export interface Ec2AsgMultiStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly vpc: VpcConstruct;
  readonly ec2Config?: Ec2Config;
  /**
   * Ports to allow from ALB to EC2 instances.
   * @default [80]
   */
  readonly ports?: number[];
  /** Allowed IP CIDRs for ALB ingress. If omitted, allows all IPv4. */
  readonly allowedIpsforAlb?: string[];
  /**
   * Minimum number of instances (distributed across AZs).
   * @default 2
   */
  readonly minCapacity?: number;
  /**
   * Maximum number of instances.
   * @default 2
   */
  readonly maxCapacity?: number;
  /** SNS topic for notifications. */
  readonly notificationTopic?: sns.ITopic;
}

/**
 * EC2 ASG Multi Stack
 *
 * Deploys an Auto Scaling Group with min=2/max=2/desired=2 instances
 * distributed across multiple Availability Zones behind an ALB.
 * Provides AZ-level redundancy: one AZ failure still leaves instances serving.
 * Rolling updates ensure at least 1 instance is healthy during deploys.
 * Access via ALB (HTTP). No direct SSH.
 */
export class Ec2AsgMultiStack extends cdk.Stack {
  public readonly asg: Ec2AsgMulti;
  public readonly alb: AlbConstruct;

  constructor(scope: Construct, id: string, props: Ec2AsgMultiStackProps) {
    super(scope, id, props);

    const ports = props.ports ?? [80];

    // ALB Security Group
    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: props.vpc.vpc,
      description: "ALB (ASG multi) - allow HTTP inbound",
      allowAllOutbound: true,
    });
    if (props.allowedIpsforAlb && props.allowedIpsforAlb.length > 0) {
      props.allowedIpsforAlb.forEach((cidr) => {
        albSecurityGroup.addIngressRule(
          ec2.Peer.ipv4(cidr),
          ec2.Port.tcp(80),
          `Allow HTTP from ${cidr}`
        );
      });
    } else {
      albSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80),
        "Allow HTTP from anywhere"
      );
    }

    // EC2 Security Group — allow inbound only from ALB
    const ec2SecurityGroup = new ec2.SecurityGroup(this, "Ec2SecurityGroup", {
      vpc: props.vpc.vpc,
      description: "EC2 ASG multi - allow inbound from ALB only",
      allowAllOutbound: true,
    });
    ports.forEach((port) => {
      ec2SecurityGroup.addIngressRule(
        ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),
        ec2.Port.tcp(port),
        `Allow port ${port} from ALB`
      );
    });

    // ALB
    this.alb = new AlbConstruct(this, "Alb", {
      project: props.project,
      environment: props.environment,
      vpc: props.vpc.vpc,
      securityGroup: albSecurityGroup,
      isALBOpen: false,
    });

    // ASG (always 2 instances across AZs)
    this.asg = new Ec2AsgMulti(this, "Ec2AsgMulti", {
      project: props.project,
      environment: props.environment,
      vpc: props.vpc.vpc,
      securityGroup: ec2SecurityGroup,
      instanceType:
        props.ec2Config?.instanceType ??
        ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        edition: ec2.AmazonLinuxEdition.STANDARD,
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      listener: this.alb.listener,
      instancePort: ports[0],
      minCapacity: props.minCapacity,
      maxCapacity: props.maxCapacity,
      rootVolumeSize: props.ec2Config?.rootVolumeSize,
      additionalUserData: props.ec2Config?.additionalUserData,
      notificationTopic: props.notificationTopic,
    });
  }
}
