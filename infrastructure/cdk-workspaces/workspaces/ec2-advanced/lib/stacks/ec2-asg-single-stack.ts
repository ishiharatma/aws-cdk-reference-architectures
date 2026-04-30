import * as cdk from "aws-cdk-lib";
import { aws_ec2 as ec2, aws_elasticloadbalancingv2 as elbv2, aws_sns as sns } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Environment } from "@common/parameters/environments";
import { VpcConstruct } from "@common/constructs/vpc/vpc";
import { AlbConstruct } from "@common/constructs/alb";
import { Ec2Config } from "parameters/environments";
import { Ec2AsgSingle } from "lib/constructs/ec2-asg-single";

export interface Ec2AsgSingleStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly vpc: VpcConstruct;
  readonly ec2Config?: Ec2Config;
  /**
   * Whether to create an Application Load Balancer in front of the ASG.
   * When `false`, no ALB is created and instances are accessible via
   * SSM Session Manager only (EC2 health check mode).
   * @default true
   */
  readonly useAlb?: boolean;
  /**
   * Ports to allow from ALB to EC2 instances.
   * Only used when `useAlb` is `true`.
   * @default [80]
   */
  readonly ports?: number[];
  /** Allowed IP CIDRs for ALB ingress. If omitted, allows all IPv4. Only used when `useAlb` is `true`. */
  readonly allowedIpsforAlb?: string[];
  readonly notificationTopic?: sns.ITopic;
}

/**
 * EC2 ASG Single Stack
 *
 * Deploys an Auto Scaling Group with min=1/max=1/desired=1 instance.
 *
 * **With ALB (`useAlb: true`, default):**
 * The ASG is placed behind an Application Load Balancer. Health checks
 * are performed by the ALB and the instance is automatically replaced on failure.
 *
 * **Without ALB (`useAlb: false`):**
 * No load balancer is created. The ASG uses EC2 instance health checks
 * and replaces the instance on failure. Access via SSM Session Manager only.
 */
export class Ec2AsgSingleStack extends cdk.Stack {
  public readonly asg: Ec2AsgSingle;
  public readonly alb: AlbConstruct | undefined;

  constructor(scope: Construct, id: string, props: Ec2AsgSingleStackProps) {
    super(scope, id, props);

    const useAlb = props.useAlb ?? true;
    const ports = props.ports ?? [80];

    let listener: elbv2.IApplicationListener | undefined;

    if (useAlb) {
      // ALB Security Group
      const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
        vpc: props.vpc.vpc,
        description: "ALB (ASG single) - allow HTTP inbound",
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
      const ec2SecurityGroupWithAlb = new ec2.SecurityGroup(this, "Ec2SecurityGroup", {
        vpc: props.vpc.vpc,
        description: "EC2 ASG single - allow inbound from ALB only",
        allowAllOutbound: true,
      });
      ports.forEach((port) => {
        ec2SecurityGroupWithAlb.addIngressRule(
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
      listener = this.alb.listener;

      // ASG (always 1 instance) with ALB
      this.asg = new Ec2AsgSingle(this, "Ec2AsgSingle", {
        project: props.project,
        environment: props.environment,
        vpc: props.vpc.vpc,
        securityGroup: ec2SecurityGroupWithAlb,
        instanceType:
          props.ec2Config?.instanceType ??
          ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
        machineImage: ec2.MachineImage.latestAmazonLinux2023({
          edition: ec2.AmazonLinuxEdition.STANDARD,
          cpuType: ec2.AmazonLinuxCpuType.ARM_64,
        }),
        listener,
        instancePort: ports[0],
        rootVolumeSize: props.ec2Config?.rootVolumeSize,
        additionalUserData: props.ec2Config?.additionalUserData,
        notificationTopic: props.notificationTopic,
      });
    } else {
      // No ALB — SSM-only mode
      const ec2SecurityGroup = new ec2.SecurityGroup(this, "Ec2SecurityGroup", {
        vpc: props.vpc.vpc,
        description: "EC2 ASG single (no ALB) - outbound only",
        allowAllOutbound: true,
      });

      // ASG (always 1 instance) without ALB
      this.asg = new Ec2AsgSingle(this, "Ec2AsgSingle", {
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
        // listener omitted → EC2 health check, SSM access only
        rootVolumeSize: props.ec2Config?.rootVolumeSize,
        additionalUserData: props.ec2Config?.additionalUserData,
        notificationTopic: props.notificationTopic,
      });
    }
  }
}
