import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { RegionInfo } from 'aws-cdk-lib/region-info';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { PlatformParams } from 'parameters/environments';
import { EcsGateway } from 'lib/constructs/ecs-gateway';

/** Properties for {@link PlatformStack}. */
export interface PlatformStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: PlatformParams;
  /** Client IPv4 addresses allowed to reach the public gateway when `restrictIngressToAllowedIps` is on. */
  readonly allowedIps: string[];
}

const ALB_LOG_PREFIX = 'gateway-public';

/**
 * Platform team stack: network, cluster, the ECS infrastructure role and two gateways
 * (internet-facing with WAF/access logs, and internal), both associated with the cluster.
 */
export class PlatformStack extends cdk.Stack {
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly publicGateway: EcsGateway;
  readonly privateGateway: EcsGateway;
  /** Cluster associations; services must be created after them and deleted before them. */
  readonly associations: cdk.CfnResource[];

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    const { params } = props;
    const namePrefix = `${props.project}-${props.environment}-ecsgw`;
    const removalPolicy = props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    // ---------------------------------------------------------------- Network
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(params.vpcCidr),
      maxAzs: 2,
      natGateways: params.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
      ],
      restrictDefaultSecurityGroup: true,
      flowLogs: { reject: { trafficType: ec2.FlowLogTrafficType.REJECT } },
    });
    this.vpc = vpc;

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `${namePrefix}-cluster`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    this.cluster = cluster;

    // ---------------------------------------------------------------- Infrastructure role
    // Application teams need neither this role nor iam:PassRole: only the gateway owner passes it.
    const infrastructureRole = new iam.Role(this, 'GatewayInfrastructureRole', {
      roleName: `${namePrefix}-gateway-infra`,
      assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonECSInfrastructureRoleForGatewayHostSharedALB')],
      description: 'Assumed by Amazon ECS to manage the ALBs, rules, target groups, security groups and certificates of the gateways',
    });

    // ---------------------------------------------------------------- Public gateway guard rails
    const webAcl = new wafv2.CfnWebACL(this, 'PublicGatewayWebAcl', {
      name: `${namePrefix}-public`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${namePrefix}-public`, sampledRequestsEnabled: true },
      rules: [
        managedRule('AWSManagedRulesCommonRuleSet', 1, namePrefix),
        managedRule('AWSManagedRulesKnownBadInputsRuleSet', 2, namePrefix),
        {
          name: 'RateLimitPerIp',
          priority: 3,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: params.publicGateway.wafRateLimit, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${namePrefix}-rate`, sampledRequestsEnabled: true },
        },
      ],
    });

    let accessLogs: { bucket: s3.IBucket; prefix: string } | undefined;
    if (params.publicGateway.accessLogs) {
      const bucket = new s3.Bucket(this, 'AlbAccessLogBucket', {
        // ALB access logs support SSE-S3 only.
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
        removalPolicy,
        autoDeleteObjects: props.isAutoDeleteObject,
      });
      // The ALBs write the logs themselves (not the infrastructure role). Older Regions deliver through
      // the regional ELB account, newer ones through the log delivery service principal.
      const logObjects = bucket.arnForObjects(`${ALB_LOG_PREFIX}/AWSLogs/${this.account}/*`);
      bucket.addToResourcePolicy(new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        principals: [new iam.ServicePrincipal('logdelivery.elasticloadbalancing.amazonaws.com')],
        resources: [logObjects],
      }));
      const elbAccount = RegionInfo.get(this.region).elbv2Account;
      if (elbAccount) {
        bucket.addToResourcePolicy(new iam.PolicyStatement({
          actions: ['s3:PutObject'],
          principals: [new iam.AccountPrincipal(elbAccount)],
          resources: [logObjects],
        }));
      }
      accessLogs = { bucket, prefix: ALB_LOG_PREFIX };
    }

    // Replaces the ECS-managed "443 from anywhere" rule. The ALBs are shared, so this applies to every service.
    let inboundSecurityGroup: ec2.SecurityGroup | undefined;
    if (params.publicGateway.restrictIngressToAllowedIps) {
      inboundSecurityGroup = new ec2.SecurityGroup(this, 'PublicGatewayInboundSecurityGroup', {
        vpc,
        description: 'Public gateway ALBs: HTTPS from the allowed client IPs only',
        allowAllOutbound: false,
      });
      for (const ip of props.allowedIps) {
        inboundSecurityGroup.addIngressRule(ec2.Peer.ipv4(ip.includes('/') ? ip : `${ip}/32`), ec2.Port.tcp(443), `client ${ip}`);
      }
    }

    // ---------------------------------------------------------------- Gateways
    // Both gateways cover the same two AZs as the service subnets; a gateway that misses an AZ
    // a service runs in is not eligible for that service.
    this.publicGateway = new EcsGateway(this, 'PublicGateway', {
      gatewayName: `${namePrefix}-public`,
      scheme: 'internet-facing',
      subnets: vpc.publicSubnets,
      infrastructureRole,
      gateway: params.publicGateway,
      inboundSecurityGroup,
      webAclArn: webAcl.attrArn,
      accessLogs,
      testTrafficHeader: params.testTrafficHeader,
    });
    if (accessLogs) {
      // ECS validates the bucket policy when it turns logging on for a new ALB.
      this.publicGateway.resource.node.addDependency(accessLogs.bucket);
    }

    this.privateGateway = new EcsGateway(this, 'PrivateGateway', {
      gatewayName: `${namePrefix}-private`,
      scheme: 'internal',
      subnets: vpc.privateSubnets,
      infrastructureRole,
      gateway: params.privateGateway,
      testTrafficHeader: params.testTrafficHeader,
    });

    this.associations = [
      this.publicGateway.associateWith('ClusterAssociation', cluster),
      this.privateGateway.associateWith('ClusterAssociation', cluster),
    ];

    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'PublicGatewayArn', { value: this.publicGateway.gatewayArn });
    new cdk.CfnOutput(this, 'PrivateGatewayArn', { value: this.privateGateway.gatewayArn });
    new cdk.CfnOutput(this, 'TestTrafficHeader', { value: `${params.testTrafficHeader.name}: ${params.testTrafficHeader.values[0]}` });
    if (accessLogs) {
      new cdk.CfnOutput(this, 'AlbAccessLogBucketName', { value: accessLogs.bucket.bucketName });
    }
  }
}

/** AWS managed rule group that enforces its own rule actions. */
function managedRule(name: string, priority: number, namePrefix: string): wafv2.CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    overrideAction: { none: {} },
    statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
    visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${namePrefix}-${name}`, sampledRequestsEnabled: true },
  };
}
