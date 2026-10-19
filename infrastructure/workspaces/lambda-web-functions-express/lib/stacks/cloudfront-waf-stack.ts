import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface CloudfrontWafStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  /** IPv4 addresses allowed through (evaluated after the managed rules). Omit to allow everyone. */
  readonly allowedIps?: string[];
  /** IPv6 addresses allowed through (evaluated after the managed rules). */
  readonly allowedIpv6s?: string[];
  /** Requests per client IP per 60 seconds before the rate-based rule blocks. */
  readonly rateLimitPerIp: number;
}

/**
 * WAFv2 Web ACL for the CloudFront distribution in front of the Web Function.
 *
 * A Web Function endpoint has no WAF of its own, so L7 protection is attached at
 * CloudFront. `scope: 'CLOUDFRONT'` Web ACLs can only be created in us-east-1,
 * which is why this is a separate stack.
 */
export class CloudfrontWafStack extends cdk.Stack {
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: CloudfrontWafStackProps) {
    super(scope, id, props);
    const prefix = `${props.project}-${props.environment}-lwf`;

    const metric = (name: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: `${prefix}-${name}`,
    });

    const managedRule = (name: string, priority: number): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: metric(name),
    });

    const ipv4Set = new wafv2.CfnIPSet(this, 'AllowedIpv4Set', {
      name: `${prefix}-allowed-ipv4`,
      scope: 'CLOUDFRONT',
      ipAddressVersion: 'IPV4',
      // WAF rejects /0, so "allow all" is two /1 blocks.
      addresses: props.allowedIps?.length ? props.allowedIps.map((ip) => `${ip}/32`) : ['0.0.0.0/1', '128.0.0.0/1'],
    });

    const allowStatements: wafv2.CfnWebACL.StatementProperty[] = [
      { ipSetReferenceStatement: { arn: ipv4Set.attrArn } },
    ];
    if (props.allowedIpv6s?.length) {
      const ipv6Set = new wafv2.CfnIPSet(this, 'AllowedIpv6Set', {
        name: `${prefix}-allowed-ipv6`,
        scope: 'CLOUDFRONT',
        ipAddressVersion: 'IPV6',
        addresses: props.allowedIpv6s.map((ip) => `${ip}/128`),
      });
      allowStatements.push({ ipSetReferenceStatement: { arn: ipv6Set.attrArn } });
    }

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${prefix}-cloudfront`,
      scope: 'CLOUDFRONT',
      defaultAction: { block: {} },
      visibilityConfig: metric('WebAcl'),
      rules: [
        {
          // Per-client throttling: the endpoint's own rate limit is endpoint-wide only.
          name: 'RateLimitPerIp',
          priority: 1,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: props.rateLimitPerIp, aggregateKeyType: 'IP', evaluationWindowSec: 60 } },
          visibilityConfig: metric('RateLimitPerIp'),
        },
        managedRule('AWSManagedRulesCommonRuleSet', 2),
        managedRule('AWSManagedRulesKnownBadInputsRuleSet', 3),
        {
          name: 'AllowListedIps',
          priority: 100,
          action: { allow: {} },
          statement:
            allowStatements.length === 1 ? allowStatements[0] : { orStatement: { statements: allowStatements } },
          visibilityConfig: metric('AllowListedIps'),
        },
      ],
    });

    this.webAclArn = webAcl.attrArn;
  }
}
