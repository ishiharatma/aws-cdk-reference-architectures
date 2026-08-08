import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

import { ApigwS3StubStack } from 'lib/stacks/apigw-s3-stub-stack';
import { params } from "parameters/environments";
import '../parameters';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = "ApigwS3StubTest";
const envName: Environment = Environment.TEST;
if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

describe('CDK Nag AwsSolutions Pack', () => {
  let app: cdk.App;
  let stack: ApigwS3StubStack;

  beforeAll(() => {
    // Execute CDK Nag checks
    app = new cdk.App();

    stack = new ApigwS3StubStack(app, `${projectName}-${envName}`, {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: true,
      terminationProtection: false,
      env: defaultEnv,
      envParams,
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
function applySuppressions(stack: ApigwS3StubStack): void {
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-S1',
        reason:
          'This bucket only holds example stub/mock JSON response files for demonstration and does not require server access logging.',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'The auto-generated BucketDeployment custom resource Lambda (used to seed example stub files) uses the ' +
          'AWS-managed AWSLambdaBasicExecutionRole, which is the standard CDK pattern for this construct.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Wildcards are scoped to object-level actions on a single bucket (e.g. `bucket/*`) required by the ' +
          'API Gateway S3 read role and the CDK-generated BucketDeployment custom resource; neither grants ' +
          'account-wide access.',
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'The Lambda runtime is owned and pinned internally by the CDK-generated BucketDeployment custom ' +
          'resource; it is not configurable by this stack.',
      },
      {
        id: 'AwsSolutions-APIG3',
        reason:
          'This is a basic reference architecture; WAF association is demonstrated separately in the ' +
          'cloudfront-vpc-origin workspace and is out of scope here.',
      },
      {
        id: 'AwsSolutions-APIG4',
        reason:
          'This is a mock/stub API intended for quick local prototyping (see README). Every method requires an ' +
          'API key (apiKeyRequired + UsagePlan) for lightweight throttling/auditing; adding IAM or Cognito ' +
          'authorization would defeat the purpose of a frictionless stub backend.',
      },
      {
        id: 'AwsSolutions-COG4',
        reason:
          'This is a mock/stub API with no real user identity to authenticate. See the AwsSolutions-APIG4 ' +
          'suppression for the mitigation (API key + usage plan) applied instead.',
      },
    ],
    true,
  );

}
