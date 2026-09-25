import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { DynamodbVectorSearchSemanticApiStack } from 'lib/stacks/dynamodb-vector-search-semantic-api-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'example';
const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

describe('CDK Nag AwsSolutions Pack', () => {
  let stack: DynamodbVectorSearchSemanticApiStack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new DynamodbVectorSearchSemanticApiStack(app, `${projectName}-${envName}-dynamodb-vector-search-semantic-api`, {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: true,
      env: testEnv,
      params: envParams,
    });

    // Apply suppressions (must be applied before adding Aspects)
    applySuppressions(stack);

    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  });

  test('no unsuppressed Warnings', () => {
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    if (warnings.length > 0) {
      console.log(JSON.stringify(warnings.map((w) => ({ id: w.id, entry: w.entry })), null, 2));
    }
    expect(warnings).toHaveLength(0);
  });

  test('no unsuppressed Errors', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    if (errors.length > 0) {
      console.log(JSON.stringify(errors.map((e) => ({ id: e.id, entry: e.entry })), null, 2));
    }
    expect(errors).toHaveLength(0);
  });
});

/**
 * CDK Nag suppressions.
 *
 * Only Lambda-managed-policy and API authN/Z/WAF rules are suppressed. They are intentionally out of
 * scope for this reference, which isolates DynamoDB native vector search; the README documents how
 * to add a Cognito/IAM authorizer and a WAFv2 Web ACL for production.
 */
function applySuppressions(stack: cdk.Stack): void {
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicExecutionRole (CloudWatch Logs) and AmazonAPIGatewayPushToCloudWatchLogs are the ' +
          'AWS-recommended managed policies for Lambda and API Gateway logging; scoping them by hand adds no security.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'The only wildcard is the DynamoDB Streams read grant added by the event source (stream/* on this ' +
          'table), which is the standard shape of that grant; every other statement names exact resource ARNs.',
      },
      {
        id: 'AwsSolutions-APIG3',
        reason:
          'A WAFv2 Web ACL adds a fixed monthly cost that is not needed for a learning reference; ' +
          'the usage plan throttle/quota bounds abuse. See README Security section for production hardening.',
      },
      {
        id: 'AwsSolutions-APIG4',
        reason:
          'Requests are gated by an API key + usage plan (spend cap). An API key is not an authorizer; the README ' +
          'shows how to add Cognito/IAM authorization for real users.',
      },
      {
        id: 'AwsSolutions-COG4',
        reason: 'A Cognito user pool authorizer is one of several valid options; authN/Z is out of scope here.',
      },
    ],
    true,
  );

  // The embed DLQ is itself the dead-letter target; a DLQ for the DLQ would only move the problem.
  NagSuppressions.addResourceSuppressions(
    stack.node.findChild('EmbedDlq'),
    [{ id: 'AwsSolutions-SQS3', reason: 'This queue is the dead-letter queue for the embed Lambda event source.' }],
    true,
  );
}
