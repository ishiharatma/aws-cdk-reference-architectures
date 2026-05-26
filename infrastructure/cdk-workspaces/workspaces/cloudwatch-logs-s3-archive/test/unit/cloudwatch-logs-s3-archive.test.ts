/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { CloudwatchLogsS3ArchiveBasicStack } from 'lib/stacks/cloudwatch-logs-s3-archive-basic-stack';
import { CloudwatchLogsS3ArchiveLifecycleStack } from 'lib/stacks/cloudwatch-logs-s3-archive-lifecycle-stack';
import { CloudwatchLogsS3ArchiveExistingStack } from 'lib/stacks/cloudwatch-logs-s3-archive-existing-stack';
import { params } from 'parameters/environments';
import 'test/parameters';
import * as path from 'path';
import { loadCdkContext } from '@common/test-helpers/test-context';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const cdkJsonPath = path.resolve(__dirname, '../../cdk.json');
const baseContext = loadCdkContext(cdkJsonPath);

// ============================================================================
// Stack 1: Basic
// ============================================================================
describe('CloudwatchLogsS3ArchiveBasicStack Fine-grained Assertions', () => {
    let template: Template;

    beforeAll(() => {
        const app = new cdk.App({ context: baseContext });
        const stack = new CloudwatchLogsS3ArchiveBasicStack(app, 'BasicStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        template = Template.fromStack(stack);
    });

    describe('CloudWatch Log Group', () => {
        test('should create a log group with the correct retention', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                RetentionInDays: 7,
            });
        });

        test('should create a log group for the archive (plus one for S3 auto-delete Lambda)', () => {
            // isAutoDeleteObject:true adds a CDK-managed log group for the S3 custom resource Lambda
            template.resourceCountIs('AWS::Logs::LogGroup', 2);
        });
    });

    describe('S3 Bucket', () => {
        test('should enable SSE-S3 encryption', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketEncryption: {
                    ServerSideEncryptionConfiguration: [
                        {
                            ServerSideEncryptionByDefault: {
                                SSEAlgorithm: 'AES256',
                            },
                        },
                    ],
                },
            });
        });

        test('should enable versioning', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                VersioningConfiguration: {
                    Status: 'Enabled',
                },
            });
        });

        test('should enforce SSL via bucket policy', () => {
            template.hasResourceProperties('AWS::S3::BucketPolicy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Effect: 'Deny',
                            Condition: {
                                Bool: { 'aws:SecureTransport': 'false' },
                            },
                        }),
                    ]),
                },
            });
        });

        test('should configure lifecycle rule to abort incomplete multipart uploads', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: {
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            Id: 'AbortIncompleteMultipartUploadsAfter7Days',
                            Status: 'Enabled',
                            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
                        }),
                    ]),
                },
            });
        });

        test('should configure lifecycle rule to expire non-current versions', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: {
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            Id: 'ExpireNonCurrentVersionsAfter90Days',
                            Status: 'Enabled',
                            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
                        }),
                    ]),
                },
            });
        });
    });

    describe('Kinesis Data Firehose', () => {
        test('should create exactly one delivery stream', () => {
            template.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 1);
        });

        test('should configure gzip compression', () => {
            template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
                ExtendedS3DestinationConfiguration: Match.objectLike({
                    CompressionFormat: 'GZIP',
                }),
            });
        });

        test('should configure buffering interval and size', () => {
            template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
                ExtendedS3DestinationConfiguration: Match.objectLike({
                    BufferingHints: {
                        IntervalInSeconds: 60,
                        SizeInMBs: 1,
                    },
                }),
            });
        });

        test('should use Tokyo timezone for prefix timestamps', () => {
            template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
                ExtendedS3DestinationConfiguration: Match.objectLike({
                    CustomTimeZone: 'Asia/Tokyo',
                }),
            });
        });

        test('should point to the archive S3 bucket', () => {
            template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
                ExtendedS3DestinationConfiguration: Match.objectLike({
                    BucketARN: Match.objectLike({
                        'Fn::GetAtt': Match.arrayWith([
                            Match.stringLikeRegexp('ArchiveBucket'),
                        ]),
                    }),
                }),
            });
        });
    });

    describe('IAM Roles', () => {
        test('should create Firehose role with firehose.amazonaws.com service principal', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                AssumeRolePolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Effect: 'Allow',
                            Principal: { Service: 'firehose.amazonaws.com' },
                        }),
                    ]),
                },
            });
        });

        test('should grant Firehose role S3 write permissions', () => {
            // Actions must be listed in the same order they appear in the policy
            template.hasResourceProperties('AWS::IAM::Role', {
                Policies: Match.arrayWith([
                    Match.objectLike({
                        PolicyName: 'AllowPutToS3',
                        PolicyDocument: {
                            Statement: Match.arrayWith([
                                Match.objectLike({
                                    Action: Match.arrayWith([
                                        's3:AbortMultipartUpload',
                                        's3:PutObject',
                                    ]),
                                    Effect: 'Allow',
                                }),
                            ]),
                        },
                    }),
                ]),
            });
        });

        test('should create CWL-to-Firehose role with logs.amazonaws.com service principal', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                AssumeRolePolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Effect: 'Allow',
                            Principal: { Service: 'logs.amazonaws.com' },
                        }),
                    ]),
                },
            });
        });

        test('should grant CWL-to-Firehose role PutRecord permissions', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                Policies: Match.arrayWith([
                    Match.objectLike({
                        PolicyName: 'AllowPutToFirehose',
                        PolicyDocument: {
                            Statement: Match.arrayWith([
                                Match.objectLike({
                                    Action: Match.arrayWith([
                                        'firehose:PutRecord',
                                        'firehose:PutRecordBatch',
                                    ]),
                                    Effect: 'Allow',
                                }),
                            ]),
                        },
                    }),
                ]),
            });
        });
    });

    describe('Subscription Filter', () => {
        test('should create exactly one subscription filter', () => {
            template.resourceCountIs('AWS::Logs::SubscriptionFilter', 1);
        });

        test('should point the subscription filter to the Firehose stream', () => {
            template.hasResourceProperties('AWS::Logs::SubscriptionFilter', {
                DestinationArn: Match.objectLike({
                    'Fn::GetAtt': Match.arrayWith([
                        Match.stringLikeRegexp('ArchiveDeliveryStream'),
                    ]),
                }),
            });
        });

        test('should attach the subscription filter to the log group', () => {
            template.hasResourceProperties('AWS::Logs::SubscriptionFilter', {
                LogGroupName: Match.objectLike({
                    Ref: Match.stringLikeRegexp('ArchiveLogGroup'),
                }),
            });
        });
    });

    describe('Stack Outputs', () => {
        test('should output the log group name', () => {
            template.hasOutput('LogGroupName', {
                Description: 'Name of the CloudWatch Log Group',
            });
        });

        test('should output the Firehose delivery stream name', () => {
            template.hasOutput('ArchiveDeliveryStreamName', {
                Description: 'Name of the Firehose Delivery Stream',
            });
        });

        test('should output the S3 archive bucket name', () => {
            template.hasOutput('ArchiveBucketName', {
                Description: 'Name of the S3 Archive Bucket',
            });
        });
    });

    describe('Resource Counts', () => {
        test('should create 1 S3 bucket', () => {
            template.resourceCountIs('AWS::S3::Bucket', 1);
        });

        test('should create 1 Firehose delivery stream', () => {
            template.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 1);
        });

        test('should create 3 IAM roles (Firehose→S3, CWL→Firehose, S3 auto-delete custom resource)', () => {
            // isAutoDeleteObject:true creates an extra role for the S3 auto-delete custom resource
            template.resourceCountIs('AWS::IAM::Role', 3);
        });
    });
});

// ============================================================================
// Stack 2: Lifecycle
// ============================================================================
describe('CloudwatchLogsS3ArchiveLifecycleStack Fine-grained Assertions', () => {
    let template: Template;

    beforeAll(() => {
        const app = new cdk.App({ context: baseContext });
        const stack = new CloudwatchLogsS3ArchiveLifecycleStack(app, 'LifecycleStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        template = Template.fromStack(stack);
    });

    describe('Lifecycle Rules', () => {
        test('should transition to Standard-IA after 30 days', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: {
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            Id: 'MoveToIAAfter30Days',
                            Status: 'Enabled',
                            Transitions: [
                                {
                                    StorageClass: 'STANDARD_IA',
                                    TransitionInDays: 30,
                                },
                            ],
                        }),
                    ]),
                },
            });
        });

        test('should transition to Glacier Instant Retrieval after 90 days', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: {
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            Id: 'MoveToGlacierAfter90Days',
                            Status: 'Enabled',
                            Transitions: [
                                {
                                    StorageClass: 'GLACIER_IR',
                                    TransitionInDays: 90,
                                },
                            ],
                        }),
                    ]),
                },
            });
        });

        test('should transition to Deep Archive after 365 days', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: {
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            Id: 'MoveToDeepArchiveAfter365Days',
                            Status: 'Enabled',
                            Transitions: [
                                {
                                    StorageClass: 'DEEP_ARCHIVE',
                                    TransitionInDays: 365,
                                },
                            ],
                        }),
                    ]),
                },
            });
        });

        test('should expire current objects after 2555 days', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: {
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            Id: 'ExpireCurrentObjectsAfter2555Days',
                            Status: 'Enabled',
                            ExpirationInDays: 2555,
                        }),
                    ]),
                },
            });
        });

        test('should expire non-current versions after 90 days', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: {
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            Id: 'ExpireNonCurrentVersionsAfter90Days',
                            Status: 'Enabled',
                            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
                        }),
                    ]),
                },
            });
        });

        test('should transition non-current versions to IA after 30 days', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: {
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            Id: 'NoncurrentVersionTransitionToIAAfter30Days',
                            Status: 'Enabled',
                            NoncurrentVersionTransitions: [
                                {
                                    StorageClass: 'STANDARD_IA',
                                    TransitionInDays: 30,
                                },
                            ],
                        }),
                    ]),
                },
            });
        });

        test('should abort incomplete multipart uploads after 7 days', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: {
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            Id: 'AbortIncompleteMultipartUploadsAfter7Days',
                            Status: 'Enabled',
                            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
                        }),
                    ]),
                },
            });
        });
    });

    describe('Stack Outputs', () => {
        test('should output lifecycle summary', () => {
            template.hasOutput('LifecycleSummary', {
                Description: 'Summary of the S3 lifecycle transition rules',
            });
        });
    });
});

// ============================================================================
// Stack 3: Existing Log Group
// ============================================================================
describe('CloudwatchLogsS3ArchiveExistingStack Fine-grained Assertions', () => {
    let template: Template;

    beforeAll(() => {
        const app = new cdk.App({ context: baseContext });
        const stack = new CloudwatchLogsS3ArchiveExistingStack(app, 'ExistingStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        template = Template.fromStack(stack);
    });

    describe('Subscription Filter (Existing Log Group)', () => {
        test('should create exactly one subscription filter', () => {
            template.resourceCountIs('AWS::Logs::SubscriptionFilter', 1);
        });

        test('should reference the existing log group by name (not Ref)', () => {
            template.hasResourceProperties('AWS::Logs::SubscriptionFilter', {
                LogGroupName: '/aws/lambda/test-function',
            });
        });

        test('should point the subscription filter to the Firehose stream', () => {
            template.hasResourceProperties('AWS::Logs::SubscriptionFilter', {
                DestinationArn: Match.objectLike({
                    'Fn::GetAtt': Match.arrayWith([
                        Match.stringLikeRegexp('ArchiveDeliveryStream'),
                    ]),
                }),
            });
        });
    });

    describe('Resource Counts', () => {
        test('should NOT create a log group for the archive (uses imported one)', () => {
            // The only log group is created by the S3 auto-delete custom resource Lambda
            // when isAutoDeleteObject:true; no log group is created for the archive itself
            template.resourceCountIs('AWS::Logs::LogGroup', 1);
        });

        test('should create 1 S3 bucket', () => {
            template.resourceCountIs('AWS::S3::Bucket', 1);
        });

        test('should create 1 Firehose delivery stream', () => {
            template.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 1);
        });
    });

    describe('Stack Outputs', () => {
        test('should output the imported log group name', () => {
            template.hasOutput('ImportedLogGroupName', {
                Description: 'Name of the imported (existing) CloudWatch Log Group',
                Value: '/aws/lambda/test-function',
            });
        });
    });
});
