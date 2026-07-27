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
        ec2.Port.tcp(443),
        'Allow inbound HTTPS traffic from the CloudFront managed prefix list'
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
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: this.vpc.vpc,
      internetFacing: publicAlbFailoverEnabled,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      loadBalancerName: `${props.project}-${props.environment}-Alb`,
    });
    const publicAlb = publicAlbFailoverEnabled ? 
    new elbv2.ApplicationLoadBalancer(this, 'PublicAlb', {
      vpc: this.vpc.vpc,
      internetFacing: true,
      securityGroup: publicAlbSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      loadBalancerName: `${props.project}-${props.environment}-PublicAlb`,
    }) : undefined;

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

    // Always registered, regardless of `publicAlbFailover` — so the VPC Origin stays in place
    // and ready to route back to instantly (no need to recreate it, which can take a while) once
    // an incident like the 2026-07-16 AWS CloudFront VPC Origins outage is resolved. Whether it
    // actually carries live traffic is decided below by which role it plays in the origin group.
    const vpcOriginAlb = cloudfront_origins.VpcOrigin.withApplicationLoadBalancer(alb, {
        httpPort: 80,
        // Without this, CloudFront defaults to "match-viewer": since the viewer always connects
        // over HTTPS (REDIRECT_TO_HTTPS below), CloudFront would try HTTPS to the ALB, which
        // only listens on port 80.
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        // VpcOriginEndpointConfig.Name must be unique per account. CDK auto-derives it from the
        // construct path, which doesn't change when the logical ID is overridden below — an
        // explicit name avoids colliding with the not-yet-deleted old VpcOrigin during replacement.
        vpcOriginName: `${props.project}-${props.environment}-alb-vpc-origin-v2`,
    });

    // Incident-response escape hatch: reach the same ALB as a plain public HTTP origin, bypassing
    // VPC Origin connectivity entirely (only relevant once `publicAlbFailoverEnabled` has also
    // made the ALB internet-facing, above).
    const publicAlbOrigin = publicAlbFailoverEnabled ?
      new cloudfront_origins.HttpOrigin(publicAlb!.loadBalancerDnsName, {
        httpsPort: 443,
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      }) : undefined;

    // Create Origin Group for CloudFront to route traffic to the ALB. Normally the VPC Origin is
    // primary and the S3 error page is the fallback. While `publicAlbFailover` is enabled, the
    // public HTTP origin becomes primary instead, and the VPC Origin itself becomes the
    // fallback — keeping it bound to the distribution (see comment above) at the cost of
    // temporarily losing the friendly static-page fallback, which is an acceptable trade during
    // a short-lived incident.
    const originGroup = new cloudfront_origins.OriginGroup({
      primaryOrigin: publicAlbFailoverEnabled ? publicAlbOrigin! : vpcOriginAlb,
      fallbackOrigin: publicAlbFailoverEnabled
        ? vpcOriginAlb
        : cloudfront_origins.S3BucketOrigin.withOriginAccessControl(errorBucket),
      fallbackStatusCodes: [403, 404, 500, 502, 503, 504],
    });

    // Add a behavior for the ALB path
    distribution.addBehavior(
      '/alb/*',
      originGroup,
      {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: denyAccessFunction ? [{
          function: denyAccessFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }] : [],
      }
    );

    // CloudFront's UpdateVpcOrigin API rejects any update while the origin is still associated
    // with a distribution, so an in-place property change (e.g. protocolPolicy) always fails via
    // CloudFormation with "currently associated with one or more distributions". Overriding the
    // logical ID forces CloudFormation to create a new VpcOrigin, repoint the distribution at it,
    // then delete the old one — instead of trying (and failing) to update it in place.
    this.node.findAll().forEach((child) => {
      if (child instanceof cdk.CfnResource && child.cfnResourceType === 'AWS::CloudFront::VpcOrigin') {
        child.overrideLogicalId('DistributionAlbVpcOriginV2');
      }
    });

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
