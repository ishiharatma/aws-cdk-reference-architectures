import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

//import { YoutStackName } from 'lib/stacks/your-stack';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = "example";
const envName: Environment = Environment.TEST;

describe('CDK Nag AwsSolutions Pack', () => {
  let app: cdk.App;
  let stack: YoutStackName;

  beforeAll(() => {
    // Execute CDK Nag checks
    app = new cdk.App();

    stack = new YoutStackName(app, `${projectName}-${envName}`, {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: false,
      terminationProtection: false,
      env: defaultEnv,
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
function applySuppressions(stack: YoutStackName): void {
  const stackName = stack.stackName;
  console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);
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

}
