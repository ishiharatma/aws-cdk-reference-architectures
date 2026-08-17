import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
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

describe('WafLogReportingAthenaReportStack – sample source (default)', () => {
    let template: Template;

    beforeAll(() => {
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
        template = Template.fromStack(stack);
    });

    test('provisions a Firehose delivery stream subscribed to the sample log group', () => {
        template.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 1);
        template.hasResourceProperties('AWS::Logs::SubscriptionFilter', { FilterPattern: '' });
    });

    test('Glue table uses Hive-style year/month/day partition projection', () => {
        template.hasResourceProperties('AWS::Glue::Table', {
            TableInput: Match.objectLike({
                PartitionKeys: [
                    { Name: 'year', Type: 'string' },
                    { Name: 'month', Type: 'string' },
                    { Name: 'day', Type: 'string' },
                ],
                Parameters: Match.objectLike({ 'projection.enabled': 'true' }),
            }),
        });
    });

    test('report Lambda is configured with the hive partition scheme', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
            Environment: { Variables: Match.objectLike({ PARTITION_SCHEME: 'hive' }) },
        });
    });

    test('Athena workgroup enforces its own configuration', () => {
        template.hasResourceProperties('AWS::Athena::WorkGroup', {
            WorkGroupConfiguration: Match.objectLike({ EnforceWorkGroupConfiguration: true }),
        });
    });

    test('S3 buckets block all public access', () => {
        const buckets = template.findResources('AWS::S3::Bucket');
        expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(2);
        Object.values(buckets).forEach((bucket) => {
            expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
                BlockPublicAcls: true,
                BlockPublicPolicy: true,
                IgnorePublicAcls: true,
                RestrictPublicBuckets: true,
            });
        });
    });

    test('an EventBridge Scheduler schedule triggers the report Lambda', () => {
        template.resourceCountIs('AWS::Scheduler::Schedule', 1);
    });
});

describe('WafLogReportingAthenaReportStack – existing source, native AWS WAF S3 layout', () => {
    test('Glue table uses a single date-projection `day` partition', () => {
        const app = new cdk.App();
        const stack = new WafLogReportingAthenaReportStack(app, 'AthenaReportExistingNative', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: {
                ...envParams,
                athenaReport: {
                    ...envParams.athenaReport,
                    existingSource: {
                        bucketName: 'existing-waf-logs-bucket',
                        webAclName: 'my-existing-webacl',
                    },
                },
            },
            sampleLogGroupName: SAMPLE_LOG_GROUP_NAME,
        });
        const template = Template.fromStack(stack);

        template.hasResourceProperties('AWS::Glue::Table', {
            TableInput: Match.objectLike({
                PartitionKeys: [{ Name: 'day', Type: 'date' }],
                StorageDescriptor: Match.objectLike({
                    Location: 's3://existing-waf-logs-bucket/AWSLogs/123456789012/WAFLogs/ap-northeast-1/my-existing-webacl/',
                }),
            }),
        });
        template.hasResourceProperties('AWS::Lambda::Function', {
            Environment: { Variables: Match.objectLike({ PARTITION_SCHEME: 'native' }) },
        });
        // No Firehose/subscription filter should be created for an existing source.
        template.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 0);
    });
});

describe('WafLogReportingAthenaReportStack – existing source, Hive-style layout', () => {
    test('Glue table uses year/month/day partition projection at the given prefix', () => {
        const app = new cdk.App();
        const stack = new WafLogReportingAthenaReportStack(app, 'AthenaReportExistingHive', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: {
                ...envParams,
                athenaReport: {
                    ...envParams.athenaReport,
                    existingSource: {
                        bucketName: 'existing-waf-logs-bucket',
                        keyPrefix: 'my-firehose-prefix/',
                        hiveStylePartitioning: true,
                    },
                },
            },
            sampleLogGroupName: SAMPLE_LOG_GROUP_NAME,
        });
        const template = Template.fromStack(stack);

        template.hasResourceProperties('AWS::Glue::Table', {
            TableInput: Match.objectLike({
                PartitionKeys: [
                    { Name: 'year', Type: 'string' },
                    { Name: 'month', Type: 'string' },
                    { Name: 'day', Type: 'string' },
                ],
                StorageDescriptor: Match.objectLike({
                    Location: 's3://existing-waf-logs-bucket/my-firehose-prefix/',
                }),
            }),
        });
    });

    test('throws when native layout is requested without webAclName or keyPrefix', () => {
        const app = new cdk.App();
        expect(
            () =>
                new WafLogReportingAthenaReportStack(app, 'AthenaReportInvalid', {
                    project: projectName,
                    environment: envName,
                    env: defaultEnv,
                    isAutoDeleteObject: true,
                    terminationProtection: false,
                    params: {
                        ...envParams,
                        athenaReport: {
                            ...envParams.athenaReport,
                            existingSource: { bucketName: 'existing-waf-logs-bucket' },
                        },
                    },
                    sampleLogGroupName: SAMPLE_LOG_GROUP_NAME,
                }),
        ).toThrow(/webAclName is required/);
    });
});
