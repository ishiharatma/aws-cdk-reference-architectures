import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { WafLogReportingCwLogsReportStack } from 'lib/stacks/waf-log-reporting-cwlogs-report-stack';
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

describe('WafLogReportingCwLogsReportStack – sample target (default)', () => {
    let template: Template;

    beforeAll(() => {
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
        template = Template.fromStack(stack);
    });

    test('reports on the sample Web ACL log group by default', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
            Environment: {
                Variables: Match.objectLike({ LOG_GROUP_NAME: SAMPLE_LOG_GROUP_NAME }),
            },
        });
    });

    test('SNS topic enforces SSL and uses the AWS-managed key', () => {
        template.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: Match.anyValue() });
        template.hasResourceProperties('AWS::SNS::TopicPolicy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Effect: 'Deny',
                        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
                    }),
                ]),
            },
        });
    });

    test('email subscription is attached to the topic', () => {
        template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email' });
    });

    test('report Lambda runs on Python 3.14 with JSON/INFO logging', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
            Runtime: 'python3.14',
            Handler: 'index.lambda_handler',
            LoggingConfig: Match.objectLike({ LogFormat: 'JSON', ApplicationLogLevel: 'INFO' }),
        });
    });

    test('IAM policy grants logs:StartQuery scoped to the target log group and sns:Publish', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({ Action: 'logs:StartQuery', Effect: 'Allow' }),
                    Match.objectLike({ Action: 'sns:Publish', Effect: 'Allow' }),
                ]),
            },
        });
    });

    test('an EventBridge Scheduler schedule triggers the report Lambda', () => {
        template.resourceCountIs('AWS::Scheduler::Schedule', 1);
    });
});

describe('WafLogReportingCwLogsReportStack – existing target', () => {
    test('reports on the configured existing log group instead of the sample one', () => {
        const app = new cdk.App();
        const stack = new WafLogReportingCwLogsReportStack(app, 'CwLogsReportExisting', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: {
                ...envParams,
                cwLogsReport: {
                    ...envParams.cwLogsReport,
                    existingLogGroupName: 'aws-waf-logs-my-existing-webacl',
                },
            },
            sampleLogGroupName: SAMPLE_LOG_GROUP_NAME,
        });
        const template = Template.fromStack(stack);

        template.hasResourceProperties('AWS::Lambda::Function', {
            Environment: {
                Variables: Match.objectLike({ LOG_GROUP_NAME: 'aws-waf-logs-my-existing-webacl' }),
            },
        });
    });
});
