/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { SqsLambdaFirehoseStack } from "lib/stacks/sqs-lambda-firehose-stack";
import { Environment } from '@common/parameters/environments';
import 'test/parameters';
import { params } from "parameters/environments";
import '../parameters';
import * as path from 'path';
import { loadCdkContext } from '@common/test-helpers/test-context';

const defaultEnv = {
    account: "123456789012",
    region: "ap-northeast-1",
};

const projectName = "TestProject";
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const cdkJsonPath = path.resolve(__dirname, "../../cdk.json");
const baseContext = loadCdkContext(cdkJsonPath);

/**
 * AWS CDK Unit Tests - Fine-grained Assertions
 *
 * This test suite aims to:
 * 1. Verify detailed configuration values of individual resources
 * 2. Check relationships between resources
 * 3. Validate security settings and cost optimization configurations
 *
 * Best practices for fine-grained assertions:
 * - Verify specific configuration values
 * - Name tests clearly to indicate their intent
 * - Test one aspect per test case
 */
describe("SqsLambdaFirehoseStack Fine-grained Assertions", () => {
    let stackTemplate: Template;

    beforeAll(() => {
        const context = {...baseContext, "aws:cdk:bundling-stacks": [],};
        const app = new cdk.App({ context });
        const stack = new SqsLambdaFirehoseStack(app, "SqsLambdaFirehose", {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        stackTemplate = Template.fromStack(stack);
    });

    // ========================================
    // SQS Queue Tests
    // ========================================
    describe("SQS Queue Configuration", () => {
        test("should create main queue with correct configuration", () => {
            stackTemplate.hasResourceProperties("AWS::SQS::Queue", {
                VisibilityTimeout: 30,
                MessageRetentionPeriod: 345600, // 4 days in seconds
                ReceiveMessageWaitTimeSeconds: 20,
                DelaySeconds: 0,
                SqsManagedSseEnabled: true,
            });
        });

        test("should create dead letter queue with correct configuration", () => {
            stackTemplate.hasResourceProperties("AWS::SQS::Queue", {
                MessageRetentionPeriod: 1209600, // 14 days
                SqsManagedSseEnabled: true,
            });
        });

        test("should configure dead letter queue for main queue", () => {
            stackTemplate.hasResourceProperties("AWS::SQS::Queue", {
                RedrivePolicy: {
                    deadLetterTargetArn: Match.objectLike({
                        "Fn::GetAtt": Match.arrayWith([
                            Match.stringLikeRegexp("SqsFirehoseDeadLetterQueue"),
                        ]),
                    }),
                    maxReceiveCount: 3,
                },
            });
        });

        test("should enforce SSL for SQS queues", () => {
            stackTemplate.hasResourceProperties("AWS::SQS::QueuePolicy", {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Effect: "Deny",
                            Condition: {
                                Bool: {
                                    "aws:SecureTransport": "false",
                                },
                            },
                        }),
                    ]),
                },
            });
        });
    });

    // ========================================
    // Lambda Function Tests
    // ========================================
    describe("Lambda Function Configuration", () => {
        test("should create Lambda function with correct runtime and architecture", () => {
            stackTemplate.hasResourceProperties("AWS::Lambda::Function", {
                Runtime: "python3.14",
                Architectures: ["x86_64"],
                Handler: "index.lambda_handler",
            });
        });

        test("should configure Lambda function with appropriate timeout and memory", () => {
            stackTemplate.hasResourceProperties("AWS::Lambda::Function", {
                Timeout: 5,
                MemorySize: 256,
            });
        });

        test("should enable tracing for Lambda function", () => {
            stackTemplate.hasResourceProperties("AWS::Lambda::Function", {
                TracingConfig: {
                    Mode: "Active",
                },
            });
        });

        test("should configure required environment variables for Lambda function", () => {
            stackTemplate.hasResourceProperties("AWS::Lambda::Function", {
                Environment: {
                    Variables: Match.objectLike({
                        PROJECT: projectName,
                        ENVIRONMENT: envName,
                        POWERTOOLS_METRICS_NAMESPACE: projectName,
                        POWERTOOLS_SERVICE_NAME: `sqs-firehose-${envName}`,
                        FIREHOSE_DELIVERY_STREAM_NAME: Match.anyValue(),
                    }),
                },
            });
        });

        test("should use JSON format logging for Lambda function", () => {
            stackTemplate.hasResourceProperties("AWS::Lambda::Function", {
                LoggingConfig: {
                    LogFormat: "JSON",
                    ApplicationLogLevel: Match.anyValue(),
                },
            });
        });

        test("should configure SQS event source for Lambda function", () => {
            stackTemplate.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
                FunctionName: Match.objectLike({
                    Ref: Match.stringLikeRegexp("SqsFirehoseFunction"),
                }),
                EventSourceArn: Match.objectLike({
                    "Fn::GetAtt": Match.arrayWith([
                        Match.stringLikeRegexp("SqsFirehoseQueue"),
                    ]),
                }),
                BatchSize: 5,
                MaximumBatchingWindowInSeconds: 60,
                FunctionResponseTypes: ["ReportBatchItemFailures"],
                Enabled: true,
            });
        });
    });

    // ========================================
    // Lambda IAM Permissions Tests
    // ========================================
    describe("Lambda IAM Permissions", () => {
        test("should grant Lambda function permissions to receive messages from SQS", () => {
            stackTemplate.hasResourceProperties("AWS::IAM::Policy", {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                "sqs:ReceiveMessage",
                                "sqs:ChangeMessageVisibility",
                                "sqs:GetQueueUrl",
                                "sqs:DeleteMessage",
                                "sqs:GetQueueAttributes",
                            ]),
                            Effect: "Allow",
                            Resource: Match.objectLike({
                                "Fn::GetAtt": Match.arrayWith([
                                    Match.stringLikeRegexp("SqsFirehoseQueue"),
                                ]),
                            }),
                        }),
                    ]),
                },
            });
        });

        test("should grant Lambda function permissions to put records to Firehose", () => {
            stackTemplate.hasResourceProperties("AWS::IAM::Policy", {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                "firehose:PutRecord",
                                "firehose:PutRecordBatch",
                            ]),
                            Effect: "Allow",
                            Resource: Match.objectLike({
                                "Fn::GetAtt": Match.arrayWith([
                                    Match.stringLikeRegexp("SqsFirehoseDeliveryStream"),
                                ]),
                            }),
                        }),
                    ]),
                },
            });
        });
    });

    // ========================================
    // Lambda Log Group Tests
    // ========================================
    describe("Lambda Log Group Configuration", () => {
        test("should create CloudWatch Logs for Lambda function", () => {
            stackTemplate.hasResourceProperties("AWS::Logs::LogGroup", {
                RetentionInDays: 7,
            });
        });

        test("should set log removal policy to DESTROY", () => {
            stackTemplate.hasResource("AWS::Logs::LogGroup", {
                UpdateReplacePolicy: "Delete",
                DeletionPolicy: "Delete",
            });
        });
    });

    // ========================================
    // S3 Bucket Tests
    // ========================================
    describe("S3 Bucket Configuration", () => {
        test("should enable encryption for S3 bucket", () => {
            stackTemplate.hasResourceProperties("AWS::S3::Bucket", {
                BucketEncryption: {
                    ServerSideEncryptionConfiguration: [
                        {
                            ServerSideEncryptionByDefault: {
                                SSEAlgorithm: "AES256",
                            },
                        },
                    ],
                },
            });
        });

        test("should enable versioning for S3 bucket", () => {
            stackTemplate.hasResourceProperties("AWS::S3::Bucket", {
                VersioningConfiguration: {
                    Status: "Enabled",
                },
            });
        });

        test("should enforce SSL for S3 bucket", () => {
            stackTemplate.hasResourceProperties("AWS::S3::BucketPolicy", {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Effect: "Deny",
                            Condition: {
                                Bool: {
                                    "aws:SecureTransport": "false",
                                },
                            },
                        }),
                    ]),
                },
            });
        });

        test("should configure appropriate lifecycle rules for S3 bucket", () => {
            stackTemplate.hasResourceProperties("AWS::S3::Bucket", {
                LifecycleConfiguration: {
                    Rules: Match.arrayWith([
                        // Glacier移行ルール
                        Match.objectLike({
                            Id: "MoveToGlacierAfter90Days",
                            Status: "Enabled",
                            Transitions: [
                                {
                                    StorageClass: "GLACIER",
                                    TransitionInDays: 90,
                                },
                            ],
                        }),
                        // オブジェクト有効期限ルール
                        Match.objectLike({
                            Id: "ExpireAfter365Days",
                            Status: "Enabled",
                            ExpirationInDays: 365,
                        }),
                        // 非現行バージョンの有効期限ルール
                        Match.objectLike({
                            Id: "ExpireNonCurrentVersionsAfter90Days",
                            Status: "Enabled",
                            NoncurrentVersionExpiration: {
                                NoncurrentDays: 90,
                            },
                        }),
                        // 非現行バージョンのIA移行ルール
                        Match.objectLike({
                            Id: "NonCurrentVersionTransitionToIAAfter30Days",
                            Status: "Enabled",
                            NoncurrentVersionTransitions: [
                                {
                                    StorageClass: "STANDARD_IA",
                                    TransitionInDays: 30,
                                },
                            ],
                        }),
                        // 現行バージョンのIA移行ルール
                        Match.objectLike({
                            Id: "CurrentVersionTransitionToIAAfter60Days",
                            Status: "Enabled",
                            Transitions: [
                                {
                                    StorageClass: "STANDARD_IA",
                                    TransitionInDays: 60,
                                },
                            ],
                        }),
                        // 未完了のマルチパートアップロード削除ルール
                        Match.objectLike({
                            Id: "AbortIncompleteMultipartUploadsAfter7Days",
                            Status: "Enabled",
                            AbortIncompleteMultipartUpload: {
                                DaysAfterInitiation: 7,
                            },
                        }),
                    ]),
                },
            });
        });
    });

    // ========================================
    // Firehose Delivery Stream Tests
    // ========================================
    describe("Firehose Delivery Stream Configuration", () => {
        test("should create Firehose delivery stream", () => {
            stackTemplate.resourceCountIs("AWS::KinesisFirehose::DeliveryStream", 1);
        });

        test("should configure Firehose to deliver to S3", () => {
            stackTemplate.hasResourceProperties("AWS::KinesisFirehose::DeliveryStream", {
                ExtendedS3DestinationConfiguration: Match.objectLike({
                    BucketARN: Match.objectLike({
                        "Fn::GetAtt": Match.arrayWith([
                            Match.stringLikeRegexp("SqsFirehoseBucket"),
                        ]),
                    }),
                    BufferingHints: {
                        IntervalInSeconds: 60,
                        SizeInMBs: 1,
                    },
                    CustomTimeZone: "Asia/Tokyo",
                    Prefix: "!{timestamp:yyyy/MM/dd}/",
                    ErrorOutputPrefix: "!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/",
                }),
            });
        });

        test("should configure appropriate IAM role for Firehose", () => {
            stackTemplate.hasResourceProperties("AWS::KinesisFirehose::DeliveryStream", {
                ExtendedS3DestinationConfiguration: Match.objectLike({
                    RoleARN: Match.objectLike({
                        "Fn::GetAtt": Match.arrayWith([
                            Match.stringLikeRegexp("FirehoseRole"),
                        ]),
                    }),
                }),
            });
        });
    });

    // ========================================
    // Firehose IAM Role Tests
    // ========================================
    describe("Firehose IAM Role Configuration", () => {
        test("should create Firehose IAM role with correct service principal", () => {
            stackTemplate.hasResourceProperties("AWS::IAM::Role", {
                AssumeRolePolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Effect: "Allow",
                            Principal: {
                                Service: "firehose.amazonaws.com",
                            },
                        }),
                    ]),
                },
            });
        });

        test("should grant appropriate S3 permissions to Firehose role", () => {
            stackTemplate.hasResourceProperties("AWS::IAM::Role", {
                Policies: Match.arrayWith([
                    Match.objectLike({
                        PolicyName: "AllowPutToS3",
                        PolicyDocument: {
                            Statement: Match.arrayWith([
                                Match.objectLike({
                                    Action: Match.arrayWith([
                                        "s3:AbortMultipartUpload",
                                        "s3:ListBucket",
                                        "s3:GetBucketLocation",
                                        "s3:GetObject",
                                        "s3:PutObject",
                                        "s3:ListBucketMultipartUploads",
                                        "s3:ListMultipartUploadParts",
                                    ]),
                                    Effect: "Allow",
                                    Resource: Match.arrayWith([
                                        Match.objectLike({
                                            "Fn::GetAtt": Match.arrayWith([
                                                Match.stringLikeRegexp("SqsFirehoseBucket"),
                                            ]),
                                        }),
                                    ]),
                                }),
                            ]),
                        },
                    }),
                ]),
            });
        });
    });

    // ========================================
    // Stack Outputs Tests
    // ========================================
    describe("Stack Outputs", () => {
        test("should output SQS queue URL", () => {
            stackTemplate.hasOutput("SqsQueueUrl", {
                Description: "URL of the SQS Queue",
                Value: Match.objectLike({
                    Ref: Match.stringLikeRegexp("SqsFirehoseQueue"),
                }),
            });
        });

        test("should output Lambda function name", () => {
            stackTemplate.hasOutput("LambdaFunctionName", {
                Description: "Name of the Lambda Function",
                Value: Match.objectLike({
                    Ref: Match.stringLikeRegexp("SqsFirehoseFunction"),
                }),
            });
        });

        test("should output Firehose delivery stream name", () => {
            stackTemplate.hasOutput("FirehoseDeliveryStreamName", {
                Description: "Name of the Firehose Delivery Stream",
                Value: Match.objectLike({
                    Ref: Match.stringLikeRegexp("SqsFirehoseDeliveryStream"),
                }),
            });
        });

        test("should output S3 bucket name", () => {
            stackTemplate.hasOutput("S3BucketName", {
                Description: "Name of the S3 Bucket",
                Value: Match.objectLike({
                    Ref: Match.stringLikeRegexp("SqsFirehoseBucket"),
                }),
            });
        });
    });

    // ========================================
    // Resource Count Tests
    // ========================================
    describe("Resource Counts", () => {
        test("should create 3 SQS queues (main queue, failure queue, and DLQ)", () => {
            stackTemplate.resourceCountIs("AWS::SQS::Queue", 3);
        });

        test("should create correct number of Lambda functions", () => {
            // Main Lambda function
            // Failure Lambda function  
            // Custom::S3AutoDeleteObjects custom resource Lambda
            stackTemplate.resourceCountIs("AWS::Lambda::Function", 3);
        });

        test("should create 1 S3 bucket", () => {
            stackTemplate.resourceCountIs("AWS::S3::Bucket", 1);
        });

        test("should create 1 Firehose delivery stream", () => {
            stackTemplate.resourceCountIs("AWS::KinesisFirehose::DeliveryStream", 1);
        });

        test("should create appropriate number of IAM roles", () => {
            // For Lambda*2, Firehose, and S3 auto-delete custom resource
            stackTemplate.resourceCountIs("AWS::IAM::Role", 4);
        });

        test("should create SNS topic for error notifications", () => {
            stackTemplate.resourceCountIs("AWS::SNS::Topic", 1);
        });

        test("should create appropriate number of CloudWatch alarms", () => {
            // SQS: 2 (Age of oldest message, Empty receives)
            // DLQ: 1 (Messages visible)
            // Firehose: 5 (DataFreshness, ThrottledRecords, IncomingBytes, IncomingRecords, IncomingPutRequests)
            // Total: 8 alarms
            stackTemplate.resourceCountIs("AWS::CloudWatch::Alarm", 8);
        });
    });

    // ========================================
    // CloudWatch Alarms Tests
    // ========================================
    describe("CloudWatch Alarms Configuration", () => {
        describe("SQS Alarms", () => {
            test("should create alarm for age of oldest message", () => {
                stackTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
                    AlarmName: "SqsApproximateAgeOfOldestMessageAlarm",
                    AlarmDescription: "Alarm when the oldest message in the SQS Queue is old",
                    MetricName: "ApproximateAgeOfOldestMessage",
                    Namespace: "AWS/SQS",
                    Threshold: 300, // 5 minutes
                    ComparisonOperator: "GreaterThanOrEqualToThreshold",
                    EvaluationPeriods: 1,
                    TreatMissingData: "notBreaching",
                });
            });

            test("should create alarm for empty receives", () => {
                stackTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
                    AlarmName: "SqsNumberOfEmptyReceivesAlarm",
                    AlarmDescription: "Alarm when there are many empty receives in the SQS Queue",
                    MetricName: "NumberOfEmptyReceives",
                    Namespace: "AWS/SQS",
                    Threshold: 100,
                    ComparisonOperator: "GreaterThanOrEqualToThreshold",
                });
            });
        });

        describe("DLQ Alarms", () => {
            test("should create alarm for DLQ messages", () => {
                stackTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
                    AlarmName: "SqsDlqApproximateNumberOfMessagesAlarm",
                    AlarmDescription: "Alarm when there are messages in the SQS Dead-letter Queue",
                    MetricName: "ApproximateNumberOfMessagesVisible",
                    Namespace: "AWS/SQS",
                    Threshold: 1,
                    ComparisonOperator: "GreaterThanOrEqualToThreshold",
                });
            });
        });

        describe("Firehose Alarms", () => {
            test("should create alarm for delivery data freshness", () => {
                stackTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
                    AlarmName: "FirehoseDeliveryToS3DataFreshnessAlarm",
                    AlarmDescription: "Alarm when Firehose falls behind in delivering data to S3",
                    Namespace: "AWS/Firehose",
                    MetricName: "DeliveryToS3.DataFreshness",
                    Statistic: "Average",
                    Period: 60,
                    Threshold: 900, // 15 minutes in seconds
                    ComparisonOperator: "GreaterThanOrEqualToThreshold",
                });
            });

            test("should create alarm for throttled records", () => {
                stackTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
                    AlarmName: "FirehoseThrottledRecordsAlarm",
                    AlarmDescription: "Alarm when Firehose has throttled records",
                    Namespace: "AWS/Firehose",
                    MetricName: "ThrottledRecords",
                    Statistic: "Sum",
                    Threshold: 1,
                    ComparisonOperator: "GreaterThanOrEqualToThreshold",
                });
            });

            test("should create alarm for high incoming bytes rate", () => {
                stackTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
                    AlarmName: Match.anyValue(),
                    AlarmDescription: "Alarm if Incoming Bytes Per Second rate is 80% of the current quota limit",
                    Threshold: 80,
                    ComparisonOperator: "GreaterThanThreshold",
                    Metrics: Match.arrayWith([
                        Match.objectLike({
                            Expression: "100*(m1/300/m2)",
                            Label: "Percentage of incoming Bytes per second quota used",
                        }),
                    ]),
                });
            });

            test("should create alarm for high incoming records rate", () => {
                stackTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
                    AlarmName: Match.anyValue(),
                    AlarmDescription: "Alarm if Incoming Records Per Second rate is 80% of the current quota limit",
                    Threshold: 80,
                    ComparisonOperator: "GreaterThanThreshold",
                    Metrics: Match.arrayWith([
                        Match.objectLike({
                            Expression: "100*(m1/300/m2)",
                            Label: "Percentage of incoming records per second quota used",
                        }),
                    ]),
                });
            });

            test("should create alarm for high incoming put requests rate", () => {
                stackTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
                    AlarmName: Match.anyValue(),
                    AlarmDescription: "Alarm if incoming put requests per second rate is 80% of the current quota limit",
                    Threshold: 80,
                    ComparisonOperator: "GreaterThanThreshold",
                    Metrics: Match.arrayWith([
                        Match.objectLike({
                            Expression: "100*(m1/300/m2)",
                            Label: "Percentage of incoming put requests quota used",
                        }),
                    ]),
                });
            });

            test("should use correct metrics for incoming bytes alarm", () => {
                stackTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
                    AlarmName: Match.anyValue(),
                    AlarmDescription: "Alarm if Incoming Bytes Per Second rate is 80% of the current quota limit",
                    Metrics: Match.arrayWith([
                        Match.objectLike({
                            Id: "m1",
                            MetricStat: {
                                Metric: {
                                    Namespace: "AWS/Firehose",
                                    MetricName: "IncomingBytes",
                                },
                                Period: 300,
                                Stat: "Sum",
                            },
                        }),
                        Match.objectLike({
                            Id: "m2",
                            MetricStat: {
                                Metric: {
                                    Namespace: "AWS/Firehose",
                                    MetricName: "BytesPerSecondLimit",
                                },
                                Period: 300,
                                Stat: "Minimum",
                            },
                        }),
                    ]),
                });
            });

            test("should use correct metrics for incoming records alarm", () => {
                stackTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
                    AlarmName: Match.anyValue(),
                    AlarmDescription: "Alarm if Incoming Records Per Second rate is 80% of the current quota limit",
                    Metrics: Match.arrayWith([
                        Match.objectLike({
                            Id: "m1",
                            MetricStat: {
                                Metric: {
                                    Namespace: "AWS/Firehose",
                                    MetricName: "IncomingRecords",
                                },
                                Period: 300,
                                Stat: "Sum",
                            },
                        }),
                        Match.objectLike({
                            Id: "m2",
                            MetricStat: {
                                Metric: {
                                    Namespace: "AWS/Firehose",
                                    MetricName: "RecordsPerSecondLimit",
                                },
                                Period: 300,
                                Stat: "Minimum",
                            },
                        }),
                    ]),
                });
            });

            test("should use correct metrics for incoming put requests alarm", () => {
                stackTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
                    AlarmName: Match.anyValue(),
                    AlarmDescription: "Alarm if incoming put requests per second rate is 80% of the current quota limit",
                    Metrics: Match.arrayWith([
                        Match.objectLike({
                            Id: "m1",
                            MetricStat: {
                                Metric: {
                                    Namespace: "AWS/Firehose",
                                    MetricName: "IncomingPutRequests",
                                },
                                Period: 300,
                                Stat: "Sum",
                            },
                        }),
                        Match.objectLike({
                            Id: "m2",
                            MetricStat: {
                                Metric: {
                                    Namespace: "AWS/Firehose",
                                    MetricName: "PutRequestsPerSecondLimit",
                                },
                                Period: 300,
                                Stat: "Minimum",
                            },
                        }),
                    ]),
                });
            });
        });

        describe("Alarm Actions", () => {
            test("should configure SNS actions for all alarms", () => {
                // All alarms should have SNS topic as alarm action
                const template = stackTemplate.toJSON();
                const alarms = Object.entries(template.Resources)
                    .filter(([_, resource]: [string, any]) => resource.Type === "AWS::CloudWatch::Alarm");
                
                expect(alarms.length).toBeGreaterThan(0);
                
                // Check that at least some alarms have AlarmActions configured
                const alarmsWithActions = alarms.filter(([_, resource]: [string, any]) => 
                    resource.Properties.AlarmActions && 
                    resource.Properties.AlarmActions.length > 0
                );
                
                expect(alarmsWithActions.length).toBeGreaterThan(0);
            });
        });
    });
});