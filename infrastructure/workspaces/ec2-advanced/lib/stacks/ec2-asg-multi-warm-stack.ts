import * as cdk from "aws-cdk-lib";
import { aws_autoscaling as autoscaling, aws_ec2 as ec2, aws_sns as sns } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Environment } from "@common/parameters/environments";
import { VpcConstruct } from "@common/constructs/vpc/vpc";
import { AlbConstruct } from "@common/constructs/alb";
import { Ec2Config } from "parameters/environments";
import { Ec2AsgMultiWarm } from "lib/constructs/ec2-asg-multi-warm";

export interface Ec2AsgMultiWarmStackProps extends cdk.StackProps {
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
   * Minimum number of in-service instances.
   * @default 2
   */
  readonly minCapacity?: number;
  /**
   * Maximum number of in-service instances (excluding warm pool).
   * @default same as minCapacity
   */
  readonly maxCapacity?: number;
  /**
   * Number of instances to keep pre-warmed in the warm pool.
   * @default 1
   */
  readonly warmPoolSize?: number;
  /**
   * The state of instances in the warm pool.
   * @default autoscaling.PoolState.HIBERNATED
   */
  readonly poolState?: autoscaling.PoolState;
  /** SNS topic for notifications. */
  readonly notificationTopic?: sns.ITopic;
}

/**
 * EC2 ASG Multi Warm Pool Stack
 *
 * Deploys an Auto Scaling Group with a pre-warmed pool of hibernated instances
 * behind an ALB. Instances in the warm pool are initialized (user data runs once)
 * and then hibernated, allowing scale-out in seconds without a full OS boot.
 *
 * **Architecture:**
 * - `minCapacity` instances always in-service (multi-AZ, behind ALB)
 * - `warmPoolSize` instances pre-warmed and hibernated
 * - On scale-out: warm instance resumes from hibernation (~10 sec)
 * - On scale-in: in-service instance returns to warm pool (reuseOnScaleIn=true)
 *
 * **Requirements:**
 * - Instance type must support hibernation (T3, C5, M5, R5, T4G, C6G, M6G, etc.)
 * - EBS root volume must be > instance RAM size
 * - AL2023 standard AMI: hibernation agent is pre-installed (no extra setup needed).
 *   AL2023 minimal AMI: install `ec2-hibinit-agent` via ec2Config.additionalUserData.
 *   @see https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/hibernation-enabled-AMI.html
 */
export class Ec2AsgMultiWarmStack extends cdk.Stack {
  public readonly asg: Ec2AsgMultiWarm;
  public readonly alb: AlbConstruct;

  constructor(scope: Construct, id: string, props: Ec2AsgMultiWarmStackProps) {
    super(scope, id, props);

    const ports = props.ports ?? [80];

    // ALB Security Group
    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: props.vpc.vpc,
      description: "ALB (ASG multi warm) - allow HTTP inbound",
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
      description: "EC2 ASG multi warm - allow inbound from ALB only",
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

    // ASG with warm pool (hibernated instances for fast scale-out)
    this.asg = new Ec2AsgMultiWarm(this, "Ec2AsgMultiWarm", {
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
      warmPoolSize: props.warmPoolSize,
      poolState: props.poolState,
      rootVolumeSize: props.ec2Config?.rootVolumeSize,
      additionalUserData: props.ec2Config?.additionalUserData,
      notificationTopic: props.notificationTopic,
    });
  }
}
