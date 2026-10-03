import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

import { ApigwVpclinkPrivateAlbStack } from 'lib/stacks/apigw-vpclink-private-alb-stack';
import { params } from "parameters/environments";
import '../parameters';

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

describe('CDK Nag AwsSolutions Pack', () => {
  let app: cdk.App;
  let stack: ApigwVpclinkPrivateAlbStack;

  beforeAll(() => {
    // Execute CDK Nag checks
    app = new cdk.App();

    stack = new ApigwVpclinkPrivateAlbStack(app, `${projectName}-${envName}`, {
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
function applySuppressions(stack: ApigwVpclinkPrivateAlbStack): void {
  //console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);

  NagSuppressions.addStackSuppressions(
    stack,
    [
      { id: 'AwsSolutions-IAM4', reason: 'The ECS task execution role and API Gateway log role use AWS managed policies recommended for logging.' },
      { id: 'AwsSolutions-IAM5', reason: 'Wildcards are limited to log streams and image pull actions that ECS requires.' },
      { id: 'AwsSolutions-ELB2', reason: 'The ALB is internal and reachable only from the VPC link; access logs need an S3 bucket that is out of scope for this reference.' },
      { id: 'AwsSolutions-ECS2', reason: 'The container environment holds no secrets or environment-specific values.' },
      { id: 'AwsSolutions-APIG2', reason: 'Requests are proxied to the backend, which validates its own input; a request validator would reject nothing useful for a pure proxy.' },
      { id: 'AwsSolutions-APIG3', reason: 'A WAFv2 Web ACL has a fixed monthly cost; the API key, usage plan and stage throttling bound abuse here. See README Security.' },
      { id: 'AwsSolutions-APIG4', reason: 'Callers are identified by an API key. Add a Cognito or IAM authorizer for end-user authorization (see cognito-apigw-auth).' },
      { id: 'AwsSolutions-COG4', reason: 'No Cognito user pool is used; access is controlled by an API key and usage plan.' },
    ],
    true,
  );

}
