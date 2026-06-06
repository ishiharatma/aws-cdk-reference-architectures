import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { CdkTSParametersStack } from "lib/stacks/cdk-ts-parameters-stack";
import { CdkJsonParametersStack } from "lib/stacks/cdk-json-parameters-stack";
import { Environment } from 'lib/types/common';
import 'test/parameters';
import { params } from "parameters/environments";
import { baseContext } from "test/helpers/test-context";

//import { YoutStackName } from 'lib/stacks/your-stack';

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
const testJsonContext = {
  "test": {
    "vpcConfig": {
        "createConfig": {
          "vpcName": "TestVPC",
          "cidr": "10.100.0.0/16",
          "maxAzs": 2,
          "natCount": 1,
          "enableDnsHostnames": true,
          "enableDnsSupport": true,
          "subnets": [
            {
              "subnetType": "PUBLIC",
              "name": "Public",
              "cidrMask": 24
            },
            {
              "subnetType": "PRIVATE_WITH_NAT",
              "name": "Private",
              "cidrMask": 24
            }
          ]
        }
    }
  }
}
const testContext: Record<string, any> = {
  ...baseContext,
  ...testJsonContext,
};

describe('CDK Nag AwsSolutions Pack', () => {
  let app: cdk.App;
  let cdkParametersStack: CdkTSParametersStack;
  let cdkJsonParametersStack: CdkJsonParametersStack;

  beforeAll(() => {
    // Execute CDK Nag checks
    app = new cdk.App({ context: testContext });

    cdkParametersStack = new CdkTSParametersStack(app, `${projectName}-${envName}`, {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: false,
      terminationProtection: false,
      env: defaultEnv,
      vpcConfig: envParams.vpcConfig,
    });

    cdkJsonParametersStack = new CdkJsonParametersStack(app, `${projectName}-json-${envName}`, {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: false,
      terminationProtection: false,
      env: defaultEnv,
    });

    // Apply suppressions (must be applied before adding Aspects)
    applySuppressions(cdkParametersStack);
    applySuppressions(cdkJsonParametersStack);
    
    // Run CDK Nag
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  });

  test('CdkParametersStack passes CDK Nag AwsSolutions checks', () => {
    const warnings = Annotations.fromStack(cdkParametersStack).findWarning(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    );
    const errors = Annotations.fromStack(cdkParametersStack).findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    );

    // Print detailed warning information for debugging
    if (warnings.length > 0) {
      console.log(`\n=== CDK Nag Warnings in stack ${cdkParametersStack.stackName} ===`);
      warnings.forEach((warning, index) => {
        console.log(`\nWarning ${index + 1}:`);
        console.log(`  Path: ${warning.id}`);
        console.log(`  Entry:`, JSON.stringify(warning.entry, null, 2));
      });
      console.log('======================\n');
    }

    // Print detailed error information for debugging
    if (errors.length > 0) {
      console.log(`\n=== CDK Nag Errors in stack ${cdkParametersStack.stackName} ===`);
      errors.forEach((error, index) => {
        console.log(`\nError ${index + 1}:`);
        console.log(`  Path: ${error.id}`);
        console.log(`  Entry:`, JSON.stringify(error.entry, null, 2));
      });
      console.log('======================\n');
    }

    expect(warnings).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test('CdkJsonParametersStack passes CDK Nag AwsSolutions checks', () => {
    const warnings = Annotations.fromStack(cdkJsonParametersStack).findWarning(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    );
    const errors = Annotations.fromStack(cdkJsonParametersStack).findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    );

    // Print detailed warning information for debugging
    if (warnings.length > 0) {
      console.log(`\n=== CDK Nag Warnings in stack ${cdkJsonParametersStack.stackName} ===`);
      warnings.forEach((warning, index) => {
        console.log(`\nWarning ${index + 1}:`);
        console.log(`  Path: ${warning.id}`);
        console.log(`  Entry:`, JSON.stringify(warning.entry, null, 2));
      });
      console.log('======================\n');
    }

    // Print detailed error information for debugging
    if (errors.length > 0) {
      console.log(`\n=== CDK Nag Errors in stack ${cdkJsonParametersStack.stackName} ===`);
      errors.forEach((error, index) => {
        console.log(`\nError ${index + 1}:`);
        console.log(`  Path: ${error.id}`);
        console.log(`  Entry:`, JSON.stringify(error.entry, null, 2));
      });
      console.log('======================\n');
    }

    expect(warnings).toHaveLength(0);
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
function applySuppressions(stack: CdkJsonParametersStack | CdkTSParametersStack): void {
  const stackName = stack.stackName;
  console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);
  const pathPrefix = `/${stackName}`;

  // Apply stack-wide suppressions for example buckets that don't require logging
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'Flow logs are not required for the example VPC in this reference architecture.',
      }
    ],
    true,
  );

}
