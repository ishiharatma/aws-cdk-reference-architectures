import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Environment } from '@common/parameters/environments';
import { SampleWafParams, defaultSampleWafConfig } from 'lib/types';
import { EnvParams } from 'parameters/environments';

export interface WafLogReportingSampleWafStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

/**
 * Stack 1 – Standalone Sample WAFv2 Web ACL
 *
 * Creates a REGIONAL Web ACL for demonstration purposes only: it is not
 * associated with any protected resource (ALB / API Gateway / CloudFront).
 * Its only purpose is to generate representative WAF logs for the two
 * report stacks in this reference architecture:
 *
 *   Rule 0 (COUNT)  – AWSManagedRulesCommonRuleSet, overrideAction: count
 *                     Demonstrates running a rule group in Count mode
 *                     (e.g. while evaluating it before promoting to Block).
 *   Rule 1 (BLOCK)  – AWSManagedRulesKnownBadInputsRuleSet, overrideAction: none
 *                     Runs the managed group's built-in Block action so the
 *                     report stacks have real BLOCK-action log entries.
 *   Rule 2 (BLOCK)  – Rate-based rule (per-IP request limit)
 *                     A second, independent source of BLOCK entries.
 *
 * Logging destination: a single CloudWatch Logs log group. AWS WAF requires
 * the log group name to start with `aws-waf-logs-`, and requires a resource
 * policy granting the log-delivery service permission to write to it.
 *
 *   Sample Web ACL --logs--> CloudWatch Logs log group ("aws-waf-logs-...")
 *     - consumed directly by Pattern 1 (CwLogsReportStack) via Logs Insights
 *     - consumed indirectly by Pattern 2 (AthenaReportStack) via a Firehose
 *       subscription filter that fans the same log group out to S3
 *
 * Both report stacks can instead target an *existing* WAF's logs (see their
 * own `existingLogGroupName` / `existingSource` parameters) — this stack is
 * only needed when you want to see the reports working end-to-end without
 * an existing WAF deployment.
 */
export class WafLogReportingSampleWafStack extends cdk.Stack {
    public readonly webAcl: wafv2.CfnWebACL;
    public readonly logGroup: logs.ILogGroup;

    constructor(scope: Construct, id: string, props: WafLogReportingSampleWafStackProps) {
        super(scope, id, props);

        const sampleWafParams: SampleWafParams = props.params.sampleWaf ?? {};
        const logRetention = sampleWafParams.logRetention ?? defaultSampleWafConfig.logRetention;
        const rateLimitPerIp = sampleWafParams.rateLimitPerIp ?? 2000;

        // -----------------------------------------------------------------------
        // CloudWatch Logs log group (WAF logging destination)
        // The "aws-waf-logs-" prefix is mandatory for AWS WAF to accept this
        // log group as a logging destination.
        // -----------------------------------------------------------------------
        this.logGroup = new logs.LogGroup(this, 'WafLogGroup', {
            logGroupName: `aws-waf-logs-${props.project}-${props.environment}`,
            retention: logRetention,
            removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
        });

        // -----------------------------------------------------------------------
        // Sample Web ACL
        // -----------------------------------------------------------------------
        const metricNamePrefix = `${props.project}-${props.environment}-waf-log-reporting`;

        this.webAcl = new wafv2.CfnWebACL(this, 'Resource', {
            name: `${props.project}-${props.environment}-waf-log-reporting-sample`,
            description:
                'Standalone sample Web ACL (not associated with any resource) that generates WAF logs '
                + 'for the waf-log-reporting reference architecture.',
            scope: 'REGIONAL',
            defaultAction: { allow: {} },
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: metricNamePrefix,
                sampledRequestsEnabled: true,
            },
            rules: [
                {
                    name: 'CommonRuleSet-Count',
                    priority: 0,
                    overrideAction: { count: {} },
                    statement: {
                        managedRuleGroupStatement: {
                            vendorName: 'AWS',
                            name: 'AWSManagedRulesCommonRuleSet',
                        },
                    },
                    visibilityConfig: {
                        cloudWatchMetricsEnabled: true,
                        metricName: `${metricNamePrefix}-common-count`,
                        sampledRequestsEnabled: true,
                    },
                },
                {
                    name: 'KnownBadInputs-Block',
                    priority: 1,
                    overrideAction: { none: {} },
                    statement: {
                        managedRuleGroupStatement: {
                            vendorName: 'AWS',
                            name: 'AWSManagedRulesKnownBadInputsRuleSet',
                        },
                    },
                    visibilityConfig: {
                        cloudWatchMetricsEnabled: true,
                        metricName: `${metricNamePrefix}-known-bad-inputs-block`,
                        sampledRequestsEnabled: true,
                    },
                },
                {
                    name: 'RateLimit-Block',
                    priority: 2,
                    action: { block: {} },
                    statement: {
                        rateBasedStatement: {
                            limit: rateLimitPerIp,
                            aggregateKeyType: 'IP',
                        },
                    },
                    visibilityConfig: {
                        cloudWatchMetricsEnabled: true,
                        metricName: `${metricNamePrefix}-rate-limit-block`,
                        sampledRequestsEnabled: true,
                    },
                },
            ],
        });

        // -----------------------------------------------------------------------
        // Resource policy: allow the log-delivery service to write WAF logs to
        // this log group, scoped to this specific Web ACL. Note this is an
        // account/region-level CloudWatch Logs resource policy (max 10 per
        // account/region) — reuse an existing policy if you already have one
        // when adapting this pattern for production use.
        // -----------------------------------------------------------------------
        new logs.CfnResourcePolicy(this, 'WafLogsResourcePolicy', {
            policyName: `${props.project}-${props.environment}-waf-log-reporting-logs`,
            policyDocument: JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                    {
                        Sid: 'AWSWafLogDeliveryWrite',
                        Effect: 'Allow',
                        Principal: { Service: 'delivery.logs.amazonaws.com' },
                        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                        Resource: `${this.logGroup.logGroupArn}:*`,
                        Condition: {
                            StringEquals: { 'aws:SourceAccount': this.account },
                            ArnLike: { 'aws:SourceArn': this.webAcl.attrArn },
                        },
                    },
                ],
            }),
        });

        // -----------------------------------------------------------------------
        // WAF Logging Configuration
        // -----------------------------------------------------------------------
        new wafv2.CfnLoggingConfiguration(this, 'LoggingConfiguration', {
            resourceArn: this.webAcl.attrArn,
            logDestinationConfigs: [this.logGroup.logGroupArn],
        });

        // -----------------------------------------------------------------------
        // Stack Outputs
        // -----------------------------------------------------------------------
        new cdk.CfnOutput(this, 'WebAclArn', {
            value: this.webAcl.attrArn,
            description: 'ARN of the standalone sample Web ACL',
        });
        new cdk.CfnOutput(this, 'WebAclName', {
            value: this.webAcl.name ?? '',
            description: 'Name of the standalone sample Web ACL',
        });
        new cdk.CfnOutput(this, 'WafLogGroupName', {
            value: this.logGroup.logGroupName,
            description: 'Name of the WAF CloudWatch Logs log group (source for both report stacks)',
        });
    }
}
