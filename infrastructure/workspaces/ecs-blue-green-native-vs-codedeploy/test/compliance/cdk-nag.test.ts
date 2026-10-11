import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

import { EcsBlueGreenNativeVsCodedeployStack } from 'lib/stacks/ecs-blue-green-native-vs-codedeploy-stack';
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
  let stack: EcsBlueGreenNativeVsCodedeployStack;

  beforeAll(() => {
    // Execute CDK Nag checks
    app = new cdk.App();

    stack = new EcsBlueGreenNativeVsCodedeployStack(app, `${projectName}-${envName}`, {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: false,
      terminationProtection: false,
      env: defaultEnv,
      params: envParams,
      allowedIps: ['203.0.113.10'],
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
function applySuppressions(stack: EcsBlueGreenNativeVsCodedeployStack): void {
  //console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);

  NagSuppressions.addStackSuppressions(
    stack,
    [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole and the AWS-managed CodeDeploy ECS service role are the AWS-documented policies for these roles.' },
      { id: 'AwsSolutions-IAM5', reason: 'ECS task execution and the ECS/CodeDeploy deployment roles need wildcard actions or resources that AWS defines without finer scope; the hook reports to any deployment.' },
      { id: 'AwsSolutions-ELB2', reason: 'The load balancers are short-lived and restricted to the operator IP; access logs need a bucket that is out of scope for this comparison.' },
      { id: 'AwsSolutions-EC23', reason: 'The ALB ingress is the operator IP only, never 0.0.0.0/0; the rule cannot read the CIDR that comes from a parameter.' },
      { id: 'AwsSolutions-ECS4', reason: 'Container Insights is a per-metric charge; the comparison is short-lived and the deployment state comes from the ECS and CodeDeploy APIs.' },
      { id: 'AwsSolutions-ECS2', reason: 'The container environment holds only a version label and a flag used by the comparison.' },
      { id: 'AwsSolutions-VPC7', reason: 'The VPC has public subnets for a short-lived comparison; load balancer traffic is not recorded.' },
      { id: 'AwsSolutions-L1', reason: 'Runtime is the latest supported Node.js version at authoring time.' },
      { id: 'CdkNagValidationFailure', reason: 'A rule could not evaluate a parameter that is an intrinsic reference.' },
    ],
    true,
  );

}
