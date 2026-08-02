import * as cdk from 'aws-cdk-lib/core';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface CloudfrontWafStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly allowedIpsBeforeRules?: string[];
    readonly allowedIpsAfterRules?: string[];
}

/**
 * WAFv2 Web ACL for the CloudFront distribution, blocking non-allowed IPs.
 *
 * A Web ACL (and any IP sets it references) with `scope: 'CLOUDFRONT'` can only be created in
 * us-east-1 — CloudFormation rejects it in any other region with "The scope is not valid." —
 * regardless of which region the CloudFront distribution itself (or the rest of this app's
 * resources) is deployed to. So this is its own stack, forced into us-east-1, whose Web ACL ARN
 * is handed to the main stack to associate with the distribution.
 */
export class CloudfrontWafStack extends cdk.Stack {
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: CloudfrontWafStackProps) {
    super(scope, id, props);

    const useBeforeWhitelist = props.allowedIpsBeforeRules && props.allowedIpsBeforeRules.length > 0;

    const wafAcl = new wafv2.CfnWebACL(this, 'WafAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { block: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${props.project}-${props.environment}-WafAcl`,
      },
      rules: [
        useBeforeWhitelist ? {
          // Specify the IP addresses to allow before evaluating the management rules.
          name: 'AllowSpecificIPsBeforeRules',
          priority: 1,
          action: { allow: {} },
          statement: {
            ipSetReferenceStatement: {
              arn: new wafv2.CfnIPSet(this, 'AllowedIpsSet', {
                addresses: (props.allowedIpsBeforeRules!).map(ip => `${ip}/32`),
                ipAddressVersion: 'IPV4',
                scope: 'CLOUDFRONT',
                name: `${props.project}-${props.environment}-AllowedIpsSetBeforeRules`,
              }).attrArn,
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${props.project}-${props.environment}-AllowSpecificIPsBeforeRules`,
          },
        } : undefined,
        {
          name: 'CoreRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${props.project}-${props.environment}-CoreRuleSet`,
          },
        },
        {
          name: 'KnownBadInputsRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${props.project}-${props.environment}-KnownBadInputsRuleSet`,
          },
        },
        // Additional managed rule groups can be added here as needed

        // Allow specific IPs after the managed rules have been applied
        // IP restrictions are applied after the managed rules are evaluated.
        // If no restrictions are specified, all connections will be allowed.
        {
          name: 'AllowSpecificIPsAfterRules',
          priority: 100,
          action: { allow: {} },
          statement: {
            ipSetReferenceStatement: {
              arn: new wafv2.CfnIPSet(this, 'AllowedIpsSetAfterRules', {
                // Default (no restriction configured): allow the entire IPv4 range, split into two
                // /1 blocks since WAF rejects a /0 CIDR. These are already full CIDRs, unlike the
                // explicit list below, so they must not be narrowed to /32 host addresses.
                addresses: props.allowedIpsAfterRules
                  ? props.allowedIpsAfterRules.map(ip => `${ip}/32`)
                  : ['0.0.0.0/1', '128.0.0.0/1'],
                ipAddressVersion: 'IPV4',
                scope: 'CLOUDFRONT',
                name: `${props.project}-${props.environment}-AllowedIpsSetAfterRules`,
              }).attrArn,
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${props.project}-${props.environment}-AllowSpecificIPsAfterRules`,
          },
        },
      ].filter(rule => rule !== undefined),
    });

    this.webAclArn = wafAcl.attrArn;

    // Bucket for direct WAF -> S3 log delivery. The "aws-waf-logs-" prefix is mandatory: AWS WAF
    // refuses to create the logging configuration below against a bucket whose name doesn't
    // start with it.
    const wafLogBucket = new s3.Bucket(this, 'WafLogBucket', {
      bucketName: `aws-waf-logs-${props.project}-${props.environment}`,
      removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.isAutoDeleteObject,
      enforceSSL: true,
    });

    // AWS WAF's direct-to-S3 log delivery writes through the same log delivery service used by
    // CloudWatch Logs/VPC Flow Logs (principal delivery.logs.amazonaws.com), which requires this
    // exact bucket policy shape to be in place before the logging configuration is created.
    wafLogBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AWSLogDeliveryWrite',
      principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [wafLogBucket.arnForObjects(`AWSLogs/${this.account}/*`)],
      conditions: {
        StringEquals: {
          's3:x-amz-acl': 'bucket-owner-full-control',
          'aws:SourceAccount': this.account,
        },
        ArnLike: {
          'aws:SourceArn': wafAcl.attrArn,
        },
      },
    }));
    wafLogBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AWSLogDeliveryAclCheck',
      principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:GetBucketAcl'],
      resources: [wafLogBucket.bucketArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': wafAcl.attrArn },
      },
    }));

    new wafv2.CfnLoggingConfiguration(this, 'WafLoggingConfiguration', {
      resourceArn: wafAcl.attrArn,
      logDestinationConfigs: [wafLogBucket.bucketArn],
      // Sample: mask fields likely to carry credentials/session tokens so they don't land in
      // logs verbatim. Add more entries (e.g. singleHeader name: 'x-api-key') as needed.
      // singleHeader is untyped (`any`) in the CDK's L1 construct, so unlike most CFN properties
      // its nested keys are passed through verbatim instead of being auto-converted from
      // camelCase — AWS's raw JSON schema requires capitalized `Name` here.
      redactedFields: [
        { singleHeader: { Name: 'authorization' } },
        { singleHeader: { Name: 'cookie' } },
      ],
    }).node.addDependency(wafLogBucket.policy!);

    new cdk.CfnOutput(this, 'WafLogBucketName', {
      value: wafLogBucket.bucketName,
      description: 'S3 bucket receiving AWS WAF logs for the CloudFront Web ACL',
    });
  }
}
