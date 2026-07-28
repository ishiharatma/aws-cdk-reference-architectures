import * as crypto from 'crypto';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfront_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';
import { VpcConfig } from '@common/types';
import { Environment } from '@common/parameters/environments';
import { PublicAlbFailoverConfig } from 'parameters/environments';

import { VpcConstruct } from '@common/constructs/vpc/vpc';

export interface StackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly vpcConfig: VpcConfig;
    /**
     * ARN of the WAFv2 Web ACL (scope CLOUDFRONT) to associate with the distribution, created by
     * `CloudfrontWafStack` in us-east-1 — see that stack for why it can't live here. Omit to
     * deploy the distribution without a Web ACL.
     */
    readonly webAclArn?: string;
    readonly allowedCloudFunctionIps?: string[];
    /**
     * CloudFront managed prefix list ID (e.g. com.amazonaws.<region>.cloudfront.origin-facing)
     * to allow ALB access from. If omitted, falls back to allowing the VPC's own CIDR block,
     * which covers CloudFront VPC origin ENI traffic even where the managed prefix list doesn't.
     */
    readonly cloudfrontManagedPrefixList?: string;
    /**
     * Incident-response escape hatch (see `PublicAlbFailoverConfig`). When enabled, the ALB is
     * deployed internet-facing in the VPC's public subnets and CloudFront's `/alb/*` behavior
     * routes to it as a plain public HTTP origin instead of through VPC Origin connectivity —
     * while keeping the VPC Origin registered and bound to the distribution (as the origin
     * group's fallback) so it's ready to switch straight back to. Requires
     * `cloudfrontManagedPrefixList` to be set. Defaults to disabled (current behavior: internal
     * ALB, private-isolated subnets, VPC Origin as primary).
     */
    readonly publicAlbFailover?: PublicAlbFailoverConfig;
}

export class CloudfrontVpcOriginStack extends cdk.Stack {
  public readonly vpc: VpcConstruct;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly distribution: cloudfront.Distribution;
  public readonly hasDenyAccessFunction: boolean;
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    // Create VPC
    this.vpc = new VpcConstruct(this, 'Vpc', {
      project: props.project,
      environment: props.environment,
      config: props.vpcConfig,
      prefix: [props.project, props.environment].join('/'),
    });

    // Create ALB Security Group
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc.vpc,
      securityGroupName: `${props.project}-${props.environment}-AlbSecurityGroup`,
      description: 'Security group for Application Load Balancer',
      allowAllOutbound: true,
    });
    const publicAlbSecurityGroup = new ec2.SecurityGroup(this, 'PublicAlbSecurityGroup', {
      vpc: this.vpc.vpc,
      securityGroupName: `${props.project}-${props.environment}-PublicAlbSecurityGroup`,
      description: 'Security group for Public Application Load Balancer',
      allowAllOutbound: true,
    });

    // CloudFront VPC origin traffic reaches the ALB from ENIs inside this VPC. AWS docs say the
    // CloudFront managed prefix list is sufficient, but in testing it wasn't — the ENIs use
    // private VPC IPs outside that prefix list's range. Use it when explicitly provided; otherwise
    // fall back to the VPC's own CIDR block, which reliably covers those ENI IPs.
    // This rule is kept regardless of `publicAlbFailover` so the VPC Origin path keeps working
    // and can be reverted to once AWS resolves an incident like this.
    if (props.cloudfrontManagedPrefixList) {
      albSecurityGroup.addIngressRule(
        ec2.Peer.prefixList(props.cloudfrontManagedPrefixList),
        ec2.Port.tcp(80),
        'Allow inbound HTTP traffic from the CloudFront managed prefix list'
      );
      publicAlbSecurityGroup.addIngressRule(
        ec2.Peer.prefixList(props.cloudfrontManagedPrefixList),
        ec2.Port.tcp(80),
        'Allow inbound HTTP traffic from the CloudFront managed prefix list'
      );
      } else {
      albSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(this.vpc.vpc.vpcCidrBlock),
        ec2.Port.tcp(80),
        'Allow inbound HTTP traffic from within the VPC (CloudFront VPC origin ENIs)'
      );
    }

    // Incident-response escape hatch: e.g. the 2026-07-16 AWS CloudFront VPC Origins outage,
    // where VPC Origin connectivity itself was degraded system-wide. Enabling this makes the ALB
    // internet-facing so CloudFront can reach it as a plain public HTTP origin instead of through
    // VPC Origin connectivity — see the origin swap below. Traffic still only ever flows through
    // CloudFront: the ALB's security group keeps allowing only the CloudFront managed prefix
    // list, never the raw internet, so a `cloudfrontManagedPrefixList` is required whenever this
    // is enabled.
    const publicAlbFailoverEnabled = props.publicAlbFailover?.enabled ?? false;
    if (publicAlbFailoverEnabled && !props.cloudfrontManagedPrefixList) {
      throw new Error(
        'publicAlbFailover.enabled requires cloudfrontManagedPrefixList to be set, so the ' +
        'now-internet-facing ALB\'s security group can be restricted to CloudFront\'s ' +
        'origin-facing IP range instead of the open internet.'
      );
    }

    this.albSecurityGroup = albSecurityGroup;

    // ALB is internal by default (reachable only via the CloudFront VPC Origin above). When the
    // `publicAlbFailover` escape hatch is enabled, it is redeployed internet-facing in the VPC's
    // public subnets so CloudFront can reach it as a plain public HTTP origin (see below).
    // No explicit `loadBalancerName` here: an explicit Name blocks any update that requires
    // replacement (e.g. a future Scheme change) — see
    // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-elasticloadbalancingv2-loadbalancer.html
    // ("If you specify a name, you cannot perform updates that require replacement of this
    // resource"). Use tags (updatable in place) instead to tell the two ALBs apart in the console.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: this.vpc.vpc,
      internetFacing: false,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      //loadBalancerName: `${props.project}-${props.environment}-alb-internal`, // optional, for console visibility
    });
    cdk.Tags.of(alb).add('Role', 'internal-vpc-origin');

    const publicAlb = publicAlbFailoverEnabled ?
    new elbv2.ApplicationLoadBalancer(this, 'PublicAlb', {
      vpc: this.vpc.vpc,
      internetFacing: true,
      securityGroup: publicAlbSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      //loadBalancerName: `${props.project}-${props.environment}-alb-public-failover`, // optional, for console visibility
    }) : undefined;
    if (publicAlb) {
      cdk.Tags.of(publicAlb).add('Role', 'public-alb-failover-escape-hatch');
    }

    // Secret shared between the public ALB's listener rules and the CloudFront origin's custom
    // header (see the public listener setup below), so CloudFront-originated requests can be told
    // apart from anyone else pointing traffic at this now-internet-facing ALB.
    let originVerifySecret: string | undefined;

    // Bucket for ALB access logs
    const albLogBucket = new s3.Bucket(this, 'AlbLogBucket', {
      bucketName: `${props.project}-${props.environment}-alb-log-bucket`,
      removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.isAutoDeleteObject,
      enforceSSL: true,
    });
    alb.logAccessLogs(albLogBucket);
    publicAlb?.logAccessLogs(albLogBucket, 'public-alb');
    // add a listener to the ALB
    const listener = alb.addListener('Listener', {
      port: 80,
      open: false,
    });

    // Add a default action to the listener (e.g., return a fixed response)
    listener.addAction('DefaultAction', {
      action: elbv2.ListenerAction.fixedResponse(200, {
        contentType: 'text/plain',
        messageBody: 'CloudFront with VPC Origin and ALB!',
      }),
    });
    listener.addAction('CustomPageAction', {
      action: elbv2.ListenerAction.fixedResponse(200, {
        contentType: 'text/html',
        messageBody: '<html><body><h1>Custom Page</h1><p>This is a custom page served by the ALB.</p></body></html>',
      }),
      conditions: [elbv2.ListenerCondition.pathPatterns(['/alb/custom*'])],
      priority: 10,
    });
    // add Lambda function to the listener for /lambda path
    const albLambdaFunction = new lambda.Function(this, 'AlbLambdaFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'text/plain' },
            body: 'Hello from Lambda behind ALB!',
          };
        };
      `),
    });
    listener.addTargets('LambdaTarget', {
      targets: [new elbv2_targets.LambdaTarget(albLambdaFunction)],
      conditions: [elbv2.ListenerCondition.pathPatterns(['/alb/lambda*'])],
      priority: 20,
    });

    // add a listener to the public ALB if it exists
    if (publicAlb) {
      // The CloudFront-managed-prefix-list security group rule above restricts traffic to
      // CloudFront's origin-facing IP range, but that range is shared by every CloudFront
      // distribution on AWS, not just this one — it does not prove a request came from *this*
      // distribution. Any other customer's distribution could point at this ALB's public DNS
      // name once it's internet-facing and would pass the security group check just the same.
      // AWS's documented mitigation for internet-facing ALB origins is a secret custom origin
      // header that CloudFront attaches to every origin request, checked by the ALB listener,
      // with anything else rejected by default — see
      // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/restrict-access-to-load-balancer.html
      // Generated fresh per synth: this ALB and the distribution's origin config are always
      // deployed together in this same stack, so a new value each deploy is safe (it's exactly
      // the "rotate periodically" behavior AWS recommends) and never causes a mismatch between
      // the two sides. Production use with independent rotation would source this from SSM
      // Parameter Store / Secrets Manager instead.
      originVerifySecret = crypto.randomBytes(32).toString('hex');
      const originVerifyHeaderCondition = elbv2.ListenerCondition.httpHeader('X-Origin-Verify', [originVerifySecret]);

      const publicListener = publicAlb.addListener('PublicListener', {
        port: 80,
        open: false,
      });
      // Default action: anything that didn't match a header-gated rule below (direct requests to
      // the ALB's DNS name, or another CloudFront distribution) is rejected.
      publicListener.addAction('PublicDefaultAction', {
        action: elbv2.ListenerAction.fixedResponse(403, {
          contentType: 'text/plain',
          messageBody: 'Access denied',
        }),
      });
      publicListener.addAction('PublicVerifiedDefaultAction', {
        action: elbv2.ListenerAction.fixedResponse(200, {
          contentType: 'text/plain',
          messageBody: 'CloudFront with Public ALB!',
        }),
        conditions: [originVerifyHeaderCondition],
        priority: 5,
      });
      publicListener.addAction('PublicCustomPageAction', {
        action: elbv2.ListenerAction.fixedResponse(200, {
          contentType: 'text/html',
          messageBody: '<html><body><h1>Custom Page</h1><p>This is a custom page served by the Public ALB.</p></body></html>',
        }),
        conditions: [originVerifyHeaderCondition, elbv2.ListenerCondition.pathPatterns(['/alb/custom*'])],
        priority: 10,
      });
      // add Lambda function to the listener for /lambda path
      const publicAlbLambdaFunction = new lambda.Function(this, 'PublicAlbLambdaFunction', {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline(`
          exports.handler = async (event) => {
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'text/plain' },
              body: 'Hello from Lambda behind Public ALB!',
            };
          };
        `),
      });
      publicListener.addTargets('LambdaTarget', {
        targets: [new elbv2_targets.LambdaTarget(publicAlbLambdaFunction)],
        conditions: [originVerifyHeaderCondition, elbv2.ListenerCondition.pathPatterns(['/alb/lambda*'])],
        priority: 20,
      });
    }


    // Create CloudFront distribution and S3 bucket for static website hosting
    // Static website Bucket for CloudFront
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: `${props.project}-${props.environment}-website-bucket`,
      removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.isAutoDeleteObject,
      enforceSSL: true,
      publicReadAccess: false, // CloudFront will access the bucket, not public
    });
    // upload a sample index.html file to the bucket
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('../../../frontend/static-web')],
      destinationBucket: websiteBucket,
    });
    const errorBucket = new s3.Bucket(this, 'ErrorBucket', {
      bucketName: `${props.project}-${props.environment}-error-bucket`,
      removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.isAutoDeleteObject,
      enforceSSL: true,
      publicReadAccess: false, // CloudFront will access the bucket, not public
    });
    // upload a sample error.html file to the bucket
    new s3deploy.BucketDeployment(this, 'DeployErrorPage', {
      sources: [s3deploy.Source.asset('../../../frontend/error-website')],
      destinationBucket: errorBucket,
    });

    let denyAccessFunction: cloudfront.Function | undefined = undefined;
    if (props.allowedCloudFunctionIps && props.allowedCloudFunctionIps.length > 0) {
      // Create a CloudFront Function Denying access to ALB for non-allowed IPs
      denyAccessFunction = new cloudfront.Function(this, 'DenyAccessFunction', {
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        code: cloudfront.FunctionCode.fromInline(`
          import cf from 'cloudfront';

          function handler(event) {
            var request = event.request;
            var allowedIps = ${JSON.stringify(props.allowedCloudFunctionIps)};
            var clientIp = event.viewer.ip;

            if (!allowedIps.includes(clientIp)) {
              // Written to the "viewer-request-log-data" field of CloudFront standard logs (v2)
              cf.logCustomData(JSON.stringify({ clientIp: clientIp, allowedIps: allowedIps }));
              return {
                statusCode: 403,
                statusDescription: 'Forbidden',
                body: 'Access denied',
              };
            }
            return request;
          }
        `),
      });
    }
    this.hasDenyAccessFunction = !!denyAccessFunction;

    // Create CloudFront distribution
    const distribution = this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `CloudFront distribution for ${props.project}-${props.environment}`,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_3_2025,
      enableIpv6: false,
      enableLogging: true,
      // Allow Japan plus major English-speaking countries
      geoRestriction: cloudfront.GeoRestriction.allowlist('JP', 'US', 'GB', 'CA', 'AU', 'NZ', 'IE'),
      // Without this, "/" is requested from S3 as an empty object key (not "index.html"),
      // which OAC's object-scoped bucket policy denies.
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: cloudfront_origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: denyAccessFunction ? [{
          function: denyAccessFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }] : [],
      },
      logBucket: new s3.Bucket(this, 'CloudFrontLogBucket', {
        bucketName: `${props.project}-${props.environment}-cloudfront-log-bucket`,
        removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
        autoDeleteObjects: props.isAutoDeleteObject,
        enforceSSL: true,
        // CloudFront's legacy standard logging writes via the S3 "log delivery" canned ACL,
        // which requires ACLs to be enabled on the bucket and granted to that group.
        objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
        accessControl: s3.BucketAccessControl.LOG_DELIVERY_WRITE,
      }),
      logFilePrefix: `${props.project}-${props.environment}/cloudfront-logs/`,
      logIncludesCookies: true,
      // Web ACL (scope CLOUDFRONT) created in us-east-1 by `CloudfrontWafStack` — see that
      // stack's doc comment for why it can't be created here alongside the rest of this stack.
      webAclId: props.webAclArn,
    });

    // Used as the origin group's primaryOrigin when `publicAlbFailover` is disabled (the normal
    // case). Note: toggling `publicAlbFailover` changes whether this origin is referenced at all,
    // which shifts CDK's auto-generated origin index (Origin2/Origin3/...) and therefore this
    // VpcOrigin resource's logical ID — CloudFormation treats that as delete-old/create-new, so
    // flipping the escape hatch in either direction costs a VPC Origin recreation (up to ~15 min),
    // not an instant switch. Accepted trade-off for this sample; see the README for a pointer to
    // CloudFront continuous deployment / weighted routing if you need a genuinely fast, zero-
    // recreation switch in production.
    const vpcOriginAlb = cloudfront_origins.VpcOrigin.withApplicationLoadBalancer(alb, {
        httpPort: 80,
        // Without this, CloudFront defaults to "match-viewer": since the viewer always connects
        // over HTTPS (REDIRECT_TO_HTTPS below), CloudFront would try HTTPS to the ALB, which
        // only listens on port 80.
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
    });

    // Incident-response escape hatch: reach the same ALB as a plain public HTTP origin, bypassing
    // VPC Origin connectivity entirely (only relevant once `publicAlbFailoverEnabled` has also
    // made the ALB internet-facing, above).
    const publicAlbOrigin = publicAlbFailoverEnabled ?
      new cloudfront_origins.HttpOrigin(publicAlb!.loadBalancerDnsName, {
        httpPort: 80,
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        // Verified by the public ALB's listener rules (see above) — requests without this header
        // are rejected by the listener's default action instead of being forwarded.
        customHeaders: originVerifySecret ? { 'X-Origin-Verify': originVerifySecret } : undefined,
      }) : undefined;

    // Create Origin Group for CloudFront to route traffic to the ALB. The fallback is always the
    // static S3 error page — normally that's a fallback from the VPC Origin, and while
    // `publicAlbFailover` is enabled, it's a fallback from the plain public HTTP origin instead.
    // (An earlier version kept the VPC Origin bound as the fallback while the escape hatch was
    // enabled, to avoid recreating it — but since the VPC Origin's logical ID already shifts with
    // its position/role in the origin group regardless, that didn't actually avoid the
    // recreation, so it's simpler to just always fall back to the S3 error page.)
    const originGroup = new cloudfront_origins.OriginGroup({
      primaryOrigin: publicAlbFailoverEnabled ? publicAlbOrigin! : vpcOriginAlb,
      fallbackOrigin: cloudfront_origins.S3BucketOrigin.withOriginAccessControl(errorBucket),
      fallbackStatusCodes: [403, 404, 500, 502, 503, 504],
    });

    // Add a behavior for the ALB path
    distribution.addBehavior(
      '/alb/*',
      originGroup,
      {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Without this, the default CACHING_OPTIMIZED policy applies (1-day default TTL). The
        // ALB's fixed responses carry no Cache-Control header, so a single successful response
        // would get cached at the edge for up to a day, masking origin/origin-group failures
        // (including failover testing) behind a stale cached response.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        functionAssociations: denyAccessFunction ? [{
          function: denyAccessFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }] : [],
      }
    );

    // Output the CloudFront distribution domain name
    new cdk.CfnOutput(this, 'CloudFrontDistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'The domain name of the CloudFront distribution',
    });
    // Output the CloudFront distribution ID
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
      description: 'The ID of the CloudFront distribution',
    });
    // Output the cloudfront URL
    new cdk.CfnOutput(this, 'CloudFrontURL', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'The URL of the CloudFront distribution',
    });

    // Output the ALB DNS name for operational visibility. Its security group only ever admits
    // CloudFront's own IP range, so it is never directly reachable by clients in either mode.
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: publicAlbFailoverEnabled
        ? 'DNS name of the now internet-facing ALB, used by CloudFront as a plain public HTTP origin while publicAlbFailover is enabled'
        : 'DNS name of the internal ALB (reachable only via the CloudFront VPC Origin)',
    });

  }
}
