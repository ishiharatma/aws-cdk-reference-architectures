import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { WafLogReportingSampleWafStack } from 'lib/stacks/waf-log-reporting-sample-waf-stack';
import { WafLogReportingCwLogsReportStack } from 'lib/stacks/waf-log-reporting-cwlogs-report-stack';
import { WafLogReportingAthenaReportStack } from 'lib/stacks/waf-log-reporting-athena-report-stack';

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

/**
 * WAF Log Reporting Stage
 *
 * Instantiates three stacks:
 *
 *   Stack 1 (SampleWaf)    – Standalone sample Web ACL + WAF log group,
 *                            used by both report stacks unless they are
 *                            configured to target an existing WAF instead.
 *   Stack 2 (CwLogsReport) – Pattern 1: CloudWatch Logs Insights + Lambda + SNS
 *   Stack 3 (AthenaReport) – Pattern 2: Amazon Athena + Lambda + SNS
 */
export class WafLogReportingStage extends cdk.Stage {
    constructor(scope: Construct, id: string, props: StageProps) {
        super(scope, id, props);

        const commonStackProps = {
            project: props.project,
            environment: props.environment,
            env: props.env,
            terminationProtection: props.terminationProtection,
            isAutoDeleteObject: props.isAutoDeleteObject,
            params: props.params,
        };

        const sampleWafStack = new WafLogReportingSampleWafStack(
            this,
            pascalCase(`${props.project}WafLogReportingSampleWaf`),
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-waf-log-reporting-sample-waf`,
                description: 'Stack 1: Standalone sample WAFv2 Web ACL + CloudWatch Logs log group',
            },
        );

        const cwLogsReportStack = new WafLogReportingCwLogsReportStack(
            this,
            pascalCase(`${props.project}WafLogReportingCwLogsReport`),
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-waf-log-reporting-cwlogs-report`,
                description: 'Stack 2 (Pattern 1): CloudWatch Logs Insights + Lambda + SNS daily WAF report',
                sampleLogGroupName: sampleWafStack.logGroup.logGroupName,
            },
        );
        cwLogsReportStack.addStackDependency(sampleWafStack);

        const athenaReportStack = new WafLogReportingAthenaReportStack(
            this,
            pascalCase(`${props.project}WafLogReportingAthenaReport`),
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-waf-log-reporting-athena-report`,
                description: 'Stack 3 (Pattern 2): Amazon Athena + Lambda + SNS daily WAF report',
                sampleLogGroupName: sampleWafStack.logGroup.logGroupName,
            },
        );
        athenaReportStack.addStackDependency(sampleWafStack);
    }
}
