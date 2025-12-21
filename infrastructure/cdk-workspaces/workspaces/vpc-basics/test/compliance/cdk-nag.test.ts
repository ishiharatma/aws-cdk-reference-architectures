import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

import { VpcCDKDefaultStack } from 'lib/stacks/vpc-cdkdefault-stack';
import { VpcBasicsStack } from 'lib/stacks/vpc-basics-stack';
import { vpc } from 'cdk-nag/lib/rules';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = "example";
const envName: Environment = Environment.TEST;

describe('CDK Nag AwsSolutions Pack', () => {
  let app: cdk.App;
  let vpcCDKDefaultStack: VpcCDKDefaultStack;
  let vpcBasicsStack: VpcBasicsStack;

  beforeAll(() => {
    // Execute CDK Nag checks
    app = new cdk.App();

    // Add tags before creating stacks
    cdk.Tags.of(app).add('Project', projectName);
    cdk.Tags.of(app).add('Environment', envName);

    vpcCDKDefaultStack = new VpcCDKDefaultStack(app, `${projectName}-${envName}-cdkdefault`, {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: false,
      terminationProtection: false,
      env: defaultEnv,
    });
    vpcBasicsStack = new VpcBasicsStack(app, `${projectName}-${envName}-vpcbasics`, {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: false,
      terminationProtection: false,
      env: defaultEnv,
    });

    // Apply suppressions (must be applied before adding Aspects)
    applySuppressionsCDKDefaultStack(vpcCDKDefaultStack);
    applySuppressionsVpcsBasicsStack(vpcBasicsStack);
    
    // Run CDK Nag
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));


  });

  test('No unsuppressed Warnings cdkDefaultStack', () => {
    const warnings = Annotations.fromStack(vpcCDKDefaultStack).findWarning(
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

  test('No unsuppressed Errors cdkDefaultStack', () => {
    const errors = Annotations.fromStack(vpcCDKDefaultStack).findError(
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

  test('No unsuppressed Warnings vpcBasicsStack', () => {
    const warnings = Annotations.fromStack(vpcBasicsStack).findWarning(
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

  test('No unsuppressed Errors vpcBasicsStack', () => {
    const errors = Annotations.fromStack(vpcBasicsStack).findError(
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
function applySuppressionsCDKDefaultStack(stack: VpcCDKDefaultStack): void {
  const stackName = stack.stackName;
  console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);
  const pathPrefix = `/${stackName}`;

  // Suppress VPC Flow Log requirement for basic VPC example
  // This is a basic example VPC without Flow Logs enabled
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/CDKDefault/Resource`,
    [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'This is a basic VPC example without Flow Logs enabled. Flow Logs should be enabled in production environments.',
      },
    ]
  );
}

function applySuppressionsVpcsBasicsStack(stack: VpcBasicsStack): void {
  const stackName = stack.stackName;
  console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);
  const pathPrefix = `/${stackName}`;

  //
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/FlowLogBucket/Resource`,
    [
      {
        id: 'AwsSolutions-S1',
        reason: 'This is an example S3 bucket for VPC Flow Logs demonstration and does not require server access logging.',
      },
    ]
  );

  // Suppress EC23 validation failure for SSM Endpoint security groups
  // This is a known issue with CDK Nag when VPC CIDR is retrieved via Fn::GetAtt
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/CustomVPC/SSMEndpoint/SecurityGroup/Resource`,
    [
      {
        id: 'CdkNagValidationFailure',
        reason: 'CdkNagValidationFailure for AwsSolutions-EC23 is expected when VPC CIDR block is referenced via intrinsic function. The security group configuration is valid.',
      },
    ]
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/CustomVPC/SSMMessagesEndpoint/SecurityGroup/Resource`,
    [
      {
        id: 'CdkNagValidationFailure',
        reason: 'CdkNagValidationFailure for AwsSolutions-EC23 is expected when VPC CIDR block is referenced via intrinsic function. The security group configuration is valid.',
      },
    ]
  );
}
