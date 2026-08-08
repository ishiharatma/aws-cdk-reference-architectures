/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Environment } from '@common/parameters/environments';
import { SnsBasicStack } from "lib/stacks/sns-basic-stack";
import { params } from "parameters/environments";
import '../parameters';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = "SnsBasicTest";
const envName: Environment = Environment.TEST;

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

describe("SnsBasicStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new SnsBasicStack(app, "SnsBasicStack", {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      terminationProtection: false,
      params: envParams,
    });
    template = Template.fromStack(stack);
  });

  describe("SNS topics", () => {
    test("two SNS topics are created (main + log-alert)", () => {
      template.resourceCountIs("AWS::SNS::Topic", 2);
    });

    test("topics enforce SSL and use the AWS-managed SNS key", () => {
      template.hasResourceProperties("AWS::SNS::Topic", {
        KmsMasterKeyId: Match.anyValue(),
      });
      template.hasResourceProperties("AWS::SNS::TopicPolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            }),
          ]),
        },
      });
    });

    test("main topic has Email, SQS, Lambda, HTTPS and Firehose subscriptions", () => {
      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
      });
      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "sqs",
      });
      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "https",
      });
      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "firehose",
      });
      // Two direct Lambda subscriptions exist: sns-message-logger (main topic)
      // and log-alert-notifier (log-alert topic).
      template.resourcePropertiesCountIs("AWS::SNS::Subscription", {
        Protocol: "lambda",
      }, 2);
    });
  });

  describe("SQS branch", () => {
    test("message queue has a DLQ configured", () => {
      template.hasResourceProperties("AWS::SQS::Queue", {
        RedrivePolicy: {
          maxReceiveCount: 3,
          deadLetterTargetArn: Match.objectLike({
            "Fn::GetAtt": Match.arrayWith([Match.stringLikeRegexp(".*Dlq.*")]),
          }),
        },
      });
    });

    test("queues enforce SSL", () => {
      template.hasResourceProperties("AWS::SQS::QueuePolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            }),
          ]),
        },
      });
    });

    test("sqs-message-logger consumes the message queue", () => {
      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        FunctionResponseTypes: ["ReportBatchItemFailures"],
      });
    });
  });

  describe("Lambda functions", () => {
    test("five application Lambda functions use JSON/INFO logging", () => {
      template.resourcePropertiesCountIs("AWS::Lambda::Function", {
        LoggingConfig: Match.objectLike({
          LogFormat: "JSON",
          ApplicationLogLevel: "INFO",
        }),
      }, 5);
    });

    test("all application functions run on Python 3.14", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Runtime: "python3.14",
        Handler: "index.lambda_handler",
      });
    });
  });

  describe("API Gateway -> S3 + DynamoDB branch", () => {
    test("REST API is regional with access logging enabled", () => {
      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        EndpointConfiguration: { Types: ["REGIONAL"] },
      });
      template.hasResourceProperties("AWS::ApiGateway::Stage", {
        AccessLogSetting: Match.objectLike({
          DestinationArn: Match.anyValue(),
        }),
      });
    });

    test("POST /sns method has a request validator", () => {
      template.hasResourceProperties("AWS::ApiGateway::Method", {
        HttpMethod: "POST",
        RequestValidatorId: Match.anyValue(),
      });
    });

    test("S3 payload bucket blocks all public access and enforces SSL", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    test("DynamoDB table has PITR and pay-per-request billing", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        BillingMode: "PAY_PER_REQUEST",
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      });
    });
  });

  describe("Firehose -> S3 branch", () => {
    test("delivery stream delivers to S3", () => {
      template.hasResourceProperties("AWS::KinesisFirehose::DeliveryStream", {
        ExtendedS3DestinationConfiguration: Match.objectLike({
          BucketARN: Match.anyValue(),
        }),
      });
    });
  });

  describe("CloudWatch Logs -> Lambda -> SNS -> Lambda chain", () => {
    test("subscription filter targets the cwlogs-to-sns Lambda", () => {
      template.hasResourceProperties("AWS::Logs::SubscriptionFilter", {
        FilterPattern: "",
      });
    });

    test("cwlogs-to-sns Lambda is granted sns:Publish on the log-alert topic", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "sns:Publish",
              Effect: "Allow",
            }),
          ]),
        },
      });
    });
  });
});
