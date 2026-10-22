import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { CloudFrontBodyInspectionLimit, RuleAction, WebAclParams } from 'parameters/environments';

/** WAFv2 scope: CLOUDFRONT (us-east-1 only) or REGIONAL (ALB). */
export type WebAclScope = 'CLOUDFRONT' | 'REGIONAL';

/** Properties for {@link Php2ShellWebAcl}. */
export interface Php2ShellWebAclProps {
  /** Resource name prefix, e.g. `<project>-<env>-php2shell`. */
  readonly namePrefix: string;
  /** Short label of this Web ACL (`cloudfront` / `alb`). Shows up in metric names and response headers. */
  readonly label: string;
  readonly scope: WebAclScope;
  readonly acl: WebAclParams;
  /**
   * POSTs per client IP per 60 seconds; omit to leave out the rate rule. Only meaningful where
   * WAF sees the real client IP: behind CloudFront an ALB Web ACL sees edge IPs.
   */
  readonly rateLimitPostsPerIp?: number;
  /** CLOUDFRONT scope only: body inspection size limit. Regional ALB ACLs are fixed at 8 KB. */
  readonly bodyInspectionLimit?: CloudFrontBodyInspectionLimit;
  /** IPv4 addresses (without prefix length) allowed in. Omit to allow everyone (default action ALLOW). */
  readonly allowedIps?: string[];
  readonly allowedIpv6s?: string[];
  readonly removalPolicy: cdk.RemovalPolicy;
}

/**
 * Web ACL with the PHP2Shell mitigation rules from the AWS Security Blog, plus WAF logging.
 *
 * Every rule announces itself so a curl client can tell which layer acted:
 * - BLOCK responds 403 with `x-php2shell-blocked-by: <label>:<rule>`.
 * - COUNT inserts `x-amzn-waf-php2shell-<label>-<rule>: counted` into the request sent to the
 *   origin, which the PHP echo app returns as `wafHeaders`.
 */
export class Php2ShellWebAcl extends Construct {
  public readonly webAcl: wafv2.CfnWebACL;
  /** Web ACL name (also the metric name prefix). */
  public readonly webAclName: string;
  public readonly logGroup: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: Php2ShellWebAclProps) {
    super(scope, id);
    const { acl, label } = props;
    const metricPrefix = `${props.namePrefix}-${label}`;
    this.webAclName = metricPrefix;

    const visibility = (name: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: `${metricPrefix}-${name}`,
    });

    const ruleAction = (ruleName: string, action: RuleAction): wafv2.CfnWebACL.RuleActionProperty =>
      action === 'BLOCK'
        ? {
            block: {
              customResponse: {
                responseCode: 403,
                responseHeaders: [{ name: 'x-php2shell-blocked-by', value: `${label}:${ruleName}` }],
              },
            },
          }
        : {
            count: {
              customRequestHandling: {
                insertHeaders: [{ name: `php2shell-${label}-${ruleName.toLowerCase()}`, value: 'counted' }],
              },
            },
          };

    const isPost: wafv2.CfnWebACL.StatementProperty = {
      byteMatchStatement: {
        fieldToMatch: { method: {} },
        positionalConstraint: 'EXACTLY',
        searchString: 'POST',
        textTransformations: [{ priority: 0, type: 'NONE' }],
      },
    };

    // Bodies past the inspection limit: CONTINUE inspects only the first N KB, exactly as the
    // blog rule does. This is the gap the verification measures (8 KB on ALB, up to 64 KB on CloudFront).
    const bodyContains = (searchString: string): wafv2.CfnWebACL.StatementProperty => ({
      byteMatchStatement: {
        fieldToMatch: { body: { oversizeHandling: 'CONTINUE' } },
        positionalConstraint: 'CONTAINS',
        searchString,
        textTransformations: [{ priority: 0, type: 'NONE' }],
      },
    });

    const rules: wafv2.CfnWebACL.RuleProperty[] = [
      {
        name: 'PHP2Shell',
        priority: 0,
        action: ruleAction('PHP2Shell', acl.ruleActions.php2Shell),
        statement: {
          andStatement: {
            statements: [
              isPost,
              {
                orStatement: {
                  statements: [
                    {
                      byteMatchStatement: {
                        fieldToMatch: {
                          cookies: { matchPattern: { all: {} }, matchScope: 'KEY', oversizeHandling: 'CONTINUE' },
                        },
                        positionalConstraint: 'EXACTLY',
                        searchString: 'PHPSESSID',
                        textTransformations: [{ priority: 0, type: 'NONE' }],
                      },
                    },
                    bodyContains('PHPSESSID'),
                  ],
                },
              },
              bodyContains('PHP_SESSION_UPLOAD_PROGRESS'),
            ],
          },
        },
        visibilityConfig: visibility('PHP2Shell'),
      },
      {
        name: 'Block-Multipart-FormData',
        priority: 1,
        action: ruleAction('Multipart', acl.ruleActions.blockMultipart),
        statement: {
          byteMatchStatement: {
            fieldToMatch: { singleHeader: { Name: 'content-type' } },
            positionalConstraint: 'CONTAINS',
            searchString: 'multipart/form-data',
            textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
          },
        },
        visibilityConfig: visibility('BlockMultipart'),
      },
      {
        name: 'Block-Oversize-Body',
        priority: 3,
        action: ruleAction('Oversize', acl.ruleActions.blockOversizeBody),
        statement: {
          sizeConstraintStatement: {
            // MATCH treats a body beyond the inspection limit as oversize, so this rule also
            // catches bodies the string rules above can no longer see.
            fieldToMatch: { body: { oversizeHandling: 'MATCH' } },
            comparisonOperator: 'GT',
            size: acl.oversizeBodyBytes,
            textTransformations: [{ priority: 0, type: 'NONE' }],
          },
        },
        visibilityConfig: visibility('BlockOversizeBody'),
      },
    ];

    if (props.rateLimitPostsPerIp !== undefined) {
      rules.push({
        name: 'RateLimit-Posts',
        priority: 4,
        action: ruleAction('RateLimit', acl.ruleActions.rateLimitPosts),
        statement: {
          rateBasedStatement: {
            limit: props.rateLimitPostsPerIp,
            evaluationWindowSec: 60,
            aggregateKeyType: 'IP',
            scopeDownStatement: isPost,
          },
        },
        visibilityConfig: visibility('RateLimitPosts'),
      });
    }

    const allowStatements = this.buildAllowList(props);
    if (allowStatements.length > 0) {
      rules.push({
        name: 'AllowListedIps',
        priority: 100,
        action: { allow: {} },
        statement:
          allowStatements.length === 1 ? allowStatements[0] : { orStatement: { statements: allowStatements } },
        visibilityConfig: visibility('AllowListedIps'),
      });
    }

    this.webAcl = new wafv2.CfnWebACL(this, 'Resource', {
      name: metricPrefix,
      scope: props.scope,
      // A verification stack exposes a PHP origin; keep it reachable from the allowlist only.
      defaultAction: allowStatements.length > 0 ? { block: {} } : { allow: {} },
      visibilityConfig: visibility('WebAcl'),
      rules,
      associationConfig:
        props.scope === 'CLOUDFRONT' && props.bodyInspectionLimit
          ? { requestBody: { CLOUDFRONT: { defaultSizeInspectionLimit: props.bodyInspectionLimit } } }
          : undefined,
    });

    // WAF requires the `aws-waf-logs-` prefix for CloudWatch Logs destinations.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `aws-waf-logs-${metricPrefix}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy,
    });
    const logging = new wafv2.CfnLoggingConfiguration(this, 'Logging', {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [
        cdk.Stack.of(this).formatArn({
          service: 'logs',
          resource: 'log-group',
          resourceName: logGroup.logGroupName,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    });
    logging.node.addDependency(logGroup);
    this.logGroup = logGroup;
  }

  private buildAllowList(props: Php2ShellWebAclProps): wafv2.CfnWebACL.StatementProperty[] {
    const statements: wafv2.CfnWebACL.StatementProperty[] = [];
    if (props.allowedIps?.length) {
      const ipv4 = new wafv2.CfnIPSet(this, 'AllowedIpv4Set', {
        name: `${props.namePrefix}-${props.label}-allowed-ipv4`,
        scope: props.scope,
        ipAddressVersion: 'IPV4',
        addresses: props.allowedIps.map((ip) => `${ip}/32`),
      });
      statements.push({ ipSetReferenceStatement: { arn: ipv4.attrArn } });
    }
    if (props.allowedIpv6s?.length) {
      const ipv6 = new wafv2.CfnIPSet(this, 'AllowedIpv6Set', {
        name: `${props.namePrefix}-${props.label}-allowed-ipv6`,
        scope: props.scope,
        ipAddressVersion: 'IPV6',
        addresses: props.allowedIpv6s.map((ip) => `${ip}/128`),
      });
      statements.push({ ipSetReferenceStatement: { arn: ipv6.attrArn } });
    }
    return statements;
  }
}
