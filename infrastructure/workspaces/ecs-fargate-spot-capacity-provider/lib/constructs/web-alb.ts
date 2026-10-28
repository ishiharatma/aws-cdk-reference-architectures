import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/** Properties for {@link WebAlb}. */
export interface WebAlbProps {
  readonly vpc: ec2.IVpc;
  /** Client IPv4 addresses allowed on port 80. */
  readonly allowedIps: string[];
  /** Client IPv6 addresses allowed on port 80 (optional). */
  readonly allowedIpv6s?: string[];
  readonly isAutoDeleteObject: boolean;
}

/**
 * Internet-facing ALB in the public subnets of every AZ, open only to the given client IPs,
 * with access logs in a dedicated bucket.
 */
export class WebAlb extends Construct {
  public readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  public readonly listener: elbv2.IApplicationListener;
  public readonly securityGroup: ec2.ISecurityGroup;

  /** Creates the security group, access log bucket, ALB and HTTP listener. */
  constructor(scope: Construct, id: string, props: WebAlbProps) {
    super(scope, id);

    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: 'ALB: HTTP from the allowed client IPs only',
      allowAllOutbound: false,
    });
    for (const ip of props.allowedIps) {
      securityGroup.addIngressRule(ec2.Peer.ipv4(`${ip}/32`), ec2.Port.tcp(80), `HTTP from ${ip}`);
    }
    for (const ip of props.allowedIpv6s ?? []) {
      securityGroup.addIngressRule(ec2.Peer.ipv6(`${ip}/128`), ec2.Port.tcp(80), `HTTP from ${ip}`);
    }

    const accessLogBucket = new s3.Bucket(this, 'AccessLogBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.isAutoDeleteObject,
    });

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup,
      dropInvalidHeaderFields: true,
    });
    loadBalancer.logAccessLogs(accessLogBucket, 'alb');

    this.listener = loadBalancer.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });
    this.loadBalancer = loadBalancer;
    this.securityGroup = securityGroup;
  }
}
