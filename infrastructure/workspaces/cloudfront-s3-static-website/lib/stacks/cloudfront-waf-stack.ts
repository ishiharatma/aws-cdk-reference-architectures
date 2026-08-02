import * as cdk from 'aws-cdk-lib/core';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { createAccountRegionalBucket } from '@common/constructs/s3';

export interface CloudfrontWafStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    /**
     * List of IPv4 addresses to allow before evaluating the managed rules. If both this and
     * `allowedIpv6sBeforeRules` are omitted or empty, no pre-allowing will be done.
     * This is useful for allowing trusted IPs (e.g., internal corporate networks) to bypass the managed rules.
     */
    readonly allowedIpsBeforeRules?: string[];
    /**
     * List of IPv6 addresses to allow before evaluating the managed rules, in addition to
     * `allowedIpsBeforeRules`.
     */
    readonly allowedIpv6sBeforeRules?: string[];
    /**
     * List of IPv4 addresses to allow after evaluating the managed rules. If both this and
     * `allowedIpv6sAfterRules` are omitted or empty, all IPv4 and IPv6 addresses will be allowed
     * after the managed rules. If either is set, only the addresses listed (across both
     * properties) are allowed — there is no implicit "allow all" for the version you didn't list.
     * This is useful for allowing specific IPs (e.g., internal corporate networks) to access the website after the managed rules have been applied.
     */
    readonly allowedIpsAfterRules?: string[];
    /**
     * List of IPv6 addresses to allow after evaluating the managed rules, in addition to
     * `allowedIpsAfterRules`. See that property for the "allow all" fallback behavior.
     */
    readonly allowedIpv6sAfterRules?: string[];
    /**
     * Whether to enable AWS WAF for the CloudFront distribution. If omitted, defaults to false.
     * If true, the `webAclArn` property must be provided with the ARN of a WAFv2 Web ACL (scope CLOUDFRONT) to associate with the distribution.
     * If false or omitted, the distribution will be deployed without a Web ACL.
     * Note that enabling WAF incurs additional costs.
     * See: https://aws.amazon.com/waf/pricing/
     */
    readonly enableWaf?: boolean;
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

    if (!props.enableWaf) {
      // WAF is disabled, so no Web ACL is created and the ARN is undefined.
      this.webAclArn = '';
      return;
    }

    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // Build the "before rules" allow statement (bypasses the managed rules entirely) from
    // whichever of IPv4/IPv6 were specified. Unlike "after rules", there is no "allow all"
    // fallback here — if neither is specified, the whole before-rules bypass is omitted.
    const hasV4BeforeRules = !!props.allowedIpsBeforeRules?.length;
    const hasV6BeforeRules = !!props.allowedIpv6sBeforeRules?.length;
    const useBeforeWhitelist = hasV4BeforeRules || hasV6BeforeRules;

    const beforeRulesStatements: wafv2.CfnWebACL.StatementProperty[] = [];
    if (hasV4BeforeRules) {
      beforeRulesStatements.push({
        ipSetReferenceStatement: {
          arn: new wafv2.CfnIPSet(this, 'AllowedIpsSetBeforeRules', {
            addresses: props.allowedIpsBeforeRules!.map(ip => `${ip}/32`),
            ipAddressVersion: 'IPV4',
            scope: 'CLOUDFRONT',
            name: `${props.project}-${props.environment}-AllowedIpsSetBeforeRules`,
          }).attrArn,
        },
      });
    }
    if (hasV6BeforeRules) {
      beforeRulesStatements.push({
        ipSetReferenceStatement: {
          arn: new wafv2.CfnIPSet(this, 'AllowedIpv6sSetBeforeRules', {
            addresses: props.allowedIpv6sBeforeRules!.map(ip => `${ip}/128`),
            ipAddressVersion: 'IPV6',
            scope: 'CLOUDFRONT',
            name: `${props.project}-${props.environment}-AllowedIpv6sSetBeforeRules`,
          }).attrArn,
        },
      });
    }
    const beforeRulesStatement: wafv2.CfnWebACL.StatementProperty | undefined =
      beforeRulesStatements.length > 1
        ? { orStatement: { statements: beforeRulesStatements } }
        : beforeRulesStatements[0];

    // Build the "after rules" allow statement from whichever of IPv4/IPv6 were actually
    // specified. If neither was specified, fall back to allowing the entire IPv4 *and* IPv6
    // address space (both split into two /1 blocks each, since WAF rejects a /0 CIDR) — this is
    // the "no restriction" case. If either was specified, only the addresses listed are allowed;
    // there is no implicit "allow all" for the version that wasn't listed.
    const hasV4AfterRules = !!props.allowedIpsAfterRules?.length;
    const hasV6AfterRules = !!props.allowedIpv6sAfterRules?.length;
    const noRestrictionConfigured = !hasV4AfterRules && !hasV6AfterRules;

    const afterRulesStatements: wafv2.CfnWebACL.StatementProperty[] = [];
    if (hasV4AfterRules || noRestrictionConfigured) {
      afterRulesStatements.push({
        ipSetReferenceStatement: {
          arn: new wafv2.CfnIPSet(this, 'AllowedIpsSetAfterRules', {
            addresses: props.allowedIpsAfterRules
              ? props.allowedIpsAfterRules.map(ip => `${ip}/32`)
              : ['0.0.0.0/1', '128.0.0.0/1'],
            ipAddressVersion: 'IPV4',
            scope: 'CLOUDFRONT',
            name: `${props.project}-${props.environment}-AllowedIpsSetAfterRules`,
          }).attrArn,
        },
      });
    }
    if (hasV6AfterRules || noRestrictionConfigured) {
      afterRulesStatements.push({
        ipSetReferenceStatement: {
          arn: new wafv2.CfnIPSet(this, 'AllowedIpv6sSetAfterRules', {
            addresses: props.allowedIpv6sAfterRules
              ? props.allowedIpv6sAfterRules.map(ip => `${ip}/128`)
              : ['::/1', '8000::/1'],
            ipAddressVersion: 'IPV6',
            scope: 'CLOUDFRONT',
            name: `${props.project}-${props.environment}-AllowedIpv6sSetAfterRules`,
          }).attrArn,
        },
      });
    }
    // Exactly one of the two blocks above can be skipped (when only one version was explicitly
    // restricted), so afterRulesStatements always has 1 or 2 entries here.
    const afterRulesStatement: wafv2.CfnWebACL.StatementProperty =
      afterRulesStatements.length > 1 ? { orStatement: { statements: afterRulesStatements } } : afterRulesStatements[0];
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
          statement: beforeRulesStatement!,
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${props.project}-${props.environment}-AllowSpecificIPsBeforeRules`,
          },
        } : undefined,
        {
          name: 'CoreRuleSet',
          priority: 10,
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
          priority: 11,
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
        {
          name: 'AdminProtectionRuleSet',
          priority: 12,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAdminProtectionRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${props.project}-${props.environment}-AdminProtectionRuleSet`,
          },
        },
        {
          name: 'IpReputationList',
          priority: 13,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${props.project}-${props.environment}-IpReputationList`,
          },
        },
        {
          name: 'AnonymousIpList',
          priority: 14,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAnonymousIpList',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${props.project}-${props.environment}-AnonymousIpList`,
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
          statement: afterRulesStatement,
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
    const wafLogBucket = createAccountRegionalBucket({
      scope: this,
      id: 'WafLogBucket',
      project: props.project,
      environment: props.environment,
      autoDeleteObjects: props.isAutoDeleteObject,
      accessControl: s3.BucketAccessControl.LOG_DELIVERY_WRITE,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      bucketNameOverride: `aws-waf-logs-${props.project}-${props.environment}-${id}-${accountId}-${region}-an`,
      purpose: 'waf-logs',
      lifecycle: {
        intelligentTieringDays: 0,
        expirationDays: 30,
      },
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
