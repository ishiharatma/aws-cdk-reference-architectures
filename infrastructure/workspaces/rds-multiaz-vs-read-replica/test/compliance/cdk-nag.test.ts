import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

import { RdsMultiazVsReadReplicaStack } from 'lib/stacks/rds-multiaz-vs-read-replica-stack';
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
  let stack: RdsMultiazVsReadReplicaStack;

  beforeAll(() => {
    // Execute CDK Nag checks
    app = new cdk.App();

    stack = new RdsMultiazVsReadReplicaStack(app, `${projectName}-${envName}`, {
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
function applySuppressions(stack: RdsMultiazVsReadReplicaStack): void {
  //console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);

  NagSuppressions.addStackSuppressions(
    stack,
    [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaVPCAccessExecutionRole and AWSLambdaBasicExecutionRole are the AWS-recommended policies for a Lambda function in a VPC.' },
      { id: 'AwsSolutions-IAM5', reason: 'The VPC access policy for Lambda needs ENI actions on all resources, which AWS defines without resource-level scope.' },
      { id: 'AwsSolutions-RDS3', reason: 'Multi-AZ is enabled on the primary; the read replica is single-AZ by design (it is for reads, not availability).' },
      { id: 'AwsSolutions-RDS2', reason: 'Storage encryption is enabled on both instances; the rule does not follow the read replica construct.' },
      { id: 'AwsSolutions-RDS6', reason: 'IAM database authentication is not used: the probe signs in with the generated secret to keep the reference small.' },
      { id: 'AwsSolutions-RDS10', reason: 'Deletion protection is on outside development; development instances must be removable.' },
      { id: 'AwsSolutions-RDS11', reason: 'The default port is kept in this isolated, probe-only network.' },
      { id: 'AwsSolutions-SMG4', reason: 'The generated secret is for a short-lived comparison; rotation is shown in the secrets-rotation-aurora pattern.' },
      { id: 'CdkNagValidationFailure', reason: 'EC23 on the interface endpoint security group could not be evaluated: its ingress CIDR is the VPC CIDR, an intrinsic reference. The group admits HTTPS from inside the VPC only.' },
      { id: 'AwsSolutions-L1', reason: 'Runtime is the latest supported Node.js version at authoring time.' },
      { id: 'AwsSolutions-VPC7', reason: 'The VPC has isolated subnets and no internet path; database traffic is recorded by the database logs.' },
    ],
    true,
  );

}
