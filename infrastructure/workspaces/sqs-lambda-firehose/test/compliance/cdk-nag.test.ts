import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

import { SqsLambdaFirehoseStack } from "lib/stacks/sqs-lambda-firehose-stack";
import { params } from "parameters/environments";
import '../parameters';
import * as path from 'path';
import { loadCdkContext } from '@common/test-helpers/test-context';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = "example";
const envName: Environment = Environment.TEST;
if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const cdkJsonPath = path.resolve(__dirname, "../../cdk.json");
const baseContext = loadCdkContext(cdkJsonPath);

describe('CDK Nag AwsSolutions Pack', () => {
  let app: cdk.App;
  let stack: SqsLambdaFirehoseStack;

  beforeAll(() => {
    // Execute CDK Nag checks
    const context = {...baseContext, "aws:cdk:bundling-stacks": [],};
    app = new cdk.App({ context });

    stack = new SqsLambdaFirehoseStack(app, `${projectName}-${envName}`, {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: false,
      terminationProtection: false,
      env: defaultEnv,
      params: envParams,
    });

    // Apply suppressions (must be applied before adding Aspects)
    applySuppressions(stack);
    
    // Run CDK Nag
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));


  });

  test('No unsuppressed Warnings', () => {
    const warnings = Annotations.fromStack(stack).findWarning(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    );
    // Print detailed warning information for debugging
    if (warnings.length > 0) {
      console.log('\n=== CDK Nag Warnings ===');
      warnings.forEach((warning, index) => {
        console.log(`\nWarning ${index + 1}:`);
        console.log(`  Path: ${warning.id}`);
        console.log(`  Entry:`, JSON.stringify(warning.entry, null, 2));
      });
      console.log('======================\n');
    }
    expect(warnings).toHaveLength(0);
  });

  test('No unsuppressed Errors', () => {
    const errors = Annotations.fromStack(stack).findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    );
    // Print detailed error information for debugging
    if (errors.length > 0) {
      console.log('\n=== CDK Nag Errors ===');
      errors.forEach((error, index) => {
        console.log(`\nError ${index + 1}:`);
        console.log(`  Path: ${error.id}`);
        console.log(`  Entry:`, JSON.stringify(error.entry, null, 2));
      });
      console.log('======================\n');
    }
    expect(errors).toHaveLength(0);
  });

});

/**
 * Apply CDK Nag suppressions to the stack
 * 
 * Best Practices:
 * 1. Apply suppressions to specific resource paths whenever possible (addResourceSuppressionsByPath)
 * 2. Minimize stack-wide suppressions (addStackSuppressions)
 * 3. Use appliesTo when there are multiple specific issues with the same resource
 * 4. Provide clear and specific reasons
 */
function applySuppressions(stack: SqsLambdaFirehoseStack): void {
  const stackName = stack.stackName;
  //console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);
  const pathPrefix = `/${stackName}`;

  // Apply stack-wide suppressions for example buckets that don't require logging
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-S1',
        reason: 'These are example S3 buckets for demonstration and do not require server access logging.',
      },
      {
        id: 'AwsSolutions-S10',
        reason: 'These are example S3 buckets for demonstration and SSL is not required.',
      },
    ],
    true,
  );

  // SQS Queue - DLQ is configured separately
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/SqsFirehoseDeadLetterQueue/Resource`,
    [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a Dead Letter Queue itself and does not require another DLQ.',
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/SqsFirehoseQueue/Resource`,
    [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'Dead Letter Queue is configured in the parameters and automatically created by CDK.',
      },
    ],
  );

  // Lambda Function Role - AWSLambdaBasicExecutionRole is standard for CloudWatch Logs
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/SqsFirehoseFunction/ServiceRole/Resource`,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is an AWS managed policy that provides minimal permissions for Lambda to write logs to CloudWatch. This is a standard and recommended practice.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
    ],
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/SqsFirehoseFunctionFailure/ServiceRole/Resource`,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is an AWS managed policy that provides minimal permissions for Lambda to write logs to CloudWatch. This is a standard and recommended practice.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
    ],
  );

  // Lambda Function Policy - X-Ray tracing requires wildcard
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/SqsFirehoseFunction/ServiceRole/DefaultPolicy/Resource`,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Lambda function requires wildcard permissions for X-Ray tracing. The resource wildcard is necessary for X-Ray to trace all invocations.',
        appliesTo: ['Resource::*'],
      },
    ],
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/SqsFirehoseFunctionFailure/ServiceRole/DefaultPolicy/Resource`,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Lambda function requires wildcard permissions for X-Ray tracing. The resource wildcard is necessary for X-Ray to trace all invocations.',
        appliesTo: ['Resource::*'],
      },
    ],
  );

  // Firehose Role - Requires specific permissions
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/FirehoseRole/Resource`,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Firehose role uses minimal required permissions for CloudWatch Logs integration.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/CloudWatchLogsFullAccess',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Firehose role requires wildcard permissions for S3 object operations. The bucket ARN wildcard (/*) is necessary for Firehose to write data to S3.',
        appliesTo: [
          'Resource::<SqsFirehoseBucket0025AD81.Arn>/*',
        ],
      },
    ],
  );

  // Firehose Role Default Policy - S3 and CloudWatch Logs require wildcards
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/FirehoseRole/DefaultPolicy/Resource`,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Firehose requires wildcard permissions for S3 object operations and CloudWatch Logs. These are necessary for Firehose to write data to S3 and create log streams.',
        appliesTo: [
          'Action::s3:Abort*',
          'Action::s3:DeleteObject*',
          'Action::s3:GetBucket*',
          'Action::s3:GetObject*',
          'Action::s3:List*',
          'Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/kinesisfirehose/*',
          'Resource::<SqsFirehoseBucket0025AD81.Arn>/*',
        ],
      },
    ],
  );

}
