import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { WafLogReportingSampleWafStack } from 'lib/stacks/waf-log-reporting-sample-waf-stack';
import { WafLogReportingCwLogsReportStack } from 'lib/stacks/waf-log-reporting-cwlogs-report-stack';
import { WafLogReportingAthenaReportStack } from 'lib/stacks/waf-log-reporting-athena-report-stack';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = 'WafLogReportingTest';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const SAMPLE_LOG_GROUP_NAME = `aws-waf-logs-${projectName}-${envName}`;

function assertNoUnsuppressedFindings(getStack: () => cdk.Stack) {
    let app: cdk.App;
    let stack: cdk.Stack;

    beforeAll(() => {
        app = new cdk.App();
        stack = getStack();
        cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test('No unsuppressed Warnings', () => {
        const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
        if (warnings.length > 0) {
            console.log('\n=== CDK Nag Warnings ===');
            warnings.forEach((w, i) => console.log(`\n${i + 1}. ${w.id}\n${JSON.stringify(w.entry, null, 2)}`));
        }
        expect(warnings).toHaveLength(0);
    });

    test('No unsuppressed Errors', () => {
        const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
        if (errors.length > 0) {
            console.log('\n=== CDK Nag Errors ===');
            errors.forEach((e, i) => console.log(`\n${i + 1}. ${e.id}\n${JSON.stringify(e.entry, null, 2)}`));
        }
        expect(errors).toHaveLength(0);
    });
}

describe('CDK Nag – WafLogReportingSampleWafStack', () => {
    assertNoUnsuppressedFindings(() => {
        const app = new cdk.App();
        const stack = new WafLogReportingSampleWafStack(app, 'SampleWaf', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        NagSuppressions.addStackSuppressions(stack, [
            {
                id: 'AwsSolutions-COG4',
                reason: 'Not applicable: this stack does not expose an API Gateway endpoint.',
            },
        ]);
        return stack;
    });
});

describe('CDK Nag – WafLogReportingCwLogsReportStack', () => {
    assertNoUnsuppressedFindings(() => {
        const app = new cdk.App();
        const stack = new WafLogReportingCwLogsReportStack(app, 'CwLogsReport', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
            sampleLogGroupName: SAMPLE_LOG_GROUP_NAME,
        });
        NagSuppressions.addStackSuppressions(
            stack,
            [
                {
                    id: 'AwsSolutions-IAM4',
                    reason:
                        'The report Lambda uses the AWS-managed AWSLambdaBasicExecutionRole for CloudWatch Logs '
                        + 'write access, the recommended pattern for functions with no other implicit AWS API access.',
                    appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
                },
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'logs:GetQueryResults/StopQuery operate on a queryId returned by StartQuery, not a log '
                        + 'group ARN, so CloudWatch Logs Insights does not support resource-level scoping for '
                        + 'these two actions (StartQuery itself is scoped to the target log group ARN).',
                },
            ],
            true,
        );
        return stack;
    });
});

describe('CDK Nag – WafLogReportingAthenaReportStack', () => {
    assertNoUnsuppressedFindings(() => {
        const app = new cdk.App();
        const stack = new WafLogReportingAthenaReportStack(app, 'AthenaReport', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
            sampleLogGroupName: SAMPLE_LOG_GROUP_NAME,
        });
        NagSuppressions.addStackSuppressions(
            stack,
            [
                {
                    id: 'AwsSolutions-S1',
                    reason: 'These are example S3 buckets for demonstration and do not require server access logging.',
                },
                {
                    id: 'AwsSolutions-IAM4',
                    reason:
                        'The report Lambda uses the AWS-managed AWSLambdaBasicExecutionRole for CloudWatch Logs '
                        + 'write access, the recommended pattern for functions with no other implicit AWS API access.',
                    appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
                },
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'Wildcards are scoped to object-level actions on a single bucket (e.g. `bucket/*`) generated '
                        + 'by the grantRead/grantReadWrite calls for the WAF logs and Athena query-results buckets, '
                        + 'not account-wide wildcards.',
                },
            ],
            true,
        );
        return stack;
    });
});
