import * as cdk from "aws-cdk-lib";
import { Annotations, Match } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import { IamBasicsStack } from "lib/stacks/iam-basics-stack";
import { Environment } from "@common/parameters/environments";

const defaultEnv = {
  account: "123456789012",
  region: "ap-northeast-1",
};

const projectName = "example";
const envName: Environment = Environment.TEST;

describe("CDK Nag AwsSolutions Pack", () => {
  let app: cdk.App;
  let stack: IamBasicsStack;

  beforeAll(() => {
    // Execute CDK Nag checks
    app = new cdk.App();

    stack = new IamBasicsStack(app, `${projectName}-${envName}`, {
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

  test("No unsuppressed Warnings", () => {
    const warnings = Annotations.fromStack(stack).findWarning(
      "*",
      Match.stringLikeRegexp("AwsSolutions-.*"),
    );
    // Print detailed warning information for debugging
    if (warnings.length > 0) {
      console.log("\n=== CDK Nag Warnings ===");
      warnings.forEach((warning, index) => {
        console.log(`\nWarning ${index + 1}:`);
        console.log(`  Path: ${warning.id}`);
        console.log(`  Entry:`, JSON.stringify(warning.entry, null, 2));
      });
      console.log("======================\n");
    }
    expect(warnings).toHaveLength(0);
  });

  test("No unsuppressed Errors", () => {
    const errors = Annotations.fromStack(stack).findError(
      "*",
      Match.stringLikeRegexp("AwsSolutions-.*"),
    );
    // Print detailed error information for debugging
    if (errors.length > 0) {
      console.log("\n=== CDK Nag Errors ===");
      errors.forEach((error, index) => {
        console.log(`\nError ${index + 1}:`);
        console.log(`  Path: ${error.id}`);
        console.log(`  Entry:`, JSON.stringify(error.entry, null, 2));
      });
      console.log("======================\n");
    }
    expect(errors).toHaveLength(0);
  });

  test("IAM resources comply with AWS Solutions checks", () => {
    // Verify that IAM resources are created
    expect(stack).toBeDefined();
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
function applySuppressions(stack: IamBasicsStack): void {
  const stackName = stack.stackName;
  console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);

  // ========================================
  // UserWithPassword Construct Suppressions
  // ========================================

  // Suppress SMG4 for PasswordSecrets
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${stackName}/UserWithPassword/PasswordSecrets/Resource`,
    [
      {
        id: "AwsSolutions-SMG4",
        reason: "Auto-rotation not configured for user password secrets in demo environment.",
      },
    ],
    true,
  );

  // Suppress IAM4 for SecretsPasswordUser (AWS Managed Policies)
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${stackName}/UserWithPassword/SecretsPasswordUser/Resource`,
    [
      {
        id: "AwsSolutions-IAM4",
        reason: "IAMUserChangePassword and ReadOnlyAccess are AWS managed policies used for demonstration purposes.",
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/IAMUserChangePassword',
          'Policy::arn:<AWS::Partition>:iam::aws:policy/ReadOnlyAccess',
        ],
      },
    ],
    true,
  );

  // Suppress IAM5 for SecretsPasswordUser DefaultPolicy (Wildcard permissions)
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${stackName}/UserWithPassword/SecretsPasswordUser/DefaultPolicy/Resource`,
    [
      {
        id: "AwsSolutions-IAM5",
        reason: "Wildcard permissions required for S3 bucket listing and Secrets Manager read access in demo.",
        appliesTo: [
          'Resource::arn:aws:s3:::*',
          'Resource::*',
        ],
      },
    ],
    true,
  );

  // ========================================
  // UserGroup Construct Suppressions
  // ========================================

  // Suppress SMG4 for PasswordSecrets
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${stackName}/UserGroup/PasswordSecrets/Resource`,
    [
      {
        id: "AwsSolutions-SMG4",
        reason: "Auto-rotation not configured for user password secrets in demo environment.",
      },
    ],
    true,
  );

  // Suppress IAM4 for User (AWS Managed Policy: IAMUserChangePassword)
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${stackName}/UserGroup/User/Resource`,
    [
      {
        id: "AwsSolutions-IAM4",
        reason: "IAMUserChangePassword is an AWS managed policy used for demonstration purposes.",
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/IAMUserChangePassword',
        ],
      },
    ],
    true,
  );

  // Suppress IAM4 for IamGroup (AWS Managed Policy: ReadOnlyAccess)
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${stackName}/UserGroup/IamGroup/Resource`,
    [
      {
        id: "AwsSolutions-IAM4",
        reason: "ReadOnlyAccess is an AWS managed policy used for demonstration purposes.",
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/ReadOnlyAccess',
        ],
      },
    ],
    true,
  );

  // ========================================
  // SwitchRoleUser Construct Suppressions
  // ========================================

  // Suppress SMG4 for PasswordSecrets
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${stackName}/SwitchRoleUser/PasswordSecrets/Resource`,
    [
      {
        id: "AwsSolutions-SMG4",
        reason: "Auto-rotation not configured for user password secrets in demo environment.",
      },
    ],
    true,
  );

  // Suppress IAM4 for User (AWS Managed Policy: IAMUserChangePassword)
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${stackName}/SwitchRoleUser/User/Resource`,
    [
      {
        id: "AwsSolutions-IAM4",
        reason: "IAMUserChangePassword is an AWS managed policy used for demonstration purposes.",
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/IAMUserChangePassword',
        ],
      },
    ],
    true,
  );

  // Suppress IAM4 for ReadOnlyRole (AWS Managed Policy: ReadOnlyAccess)
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${stackName}/SwitchRoleUser/ReadOnlyRole/Resource`,
    [
      {
        id: "AwsSolutions-IAM4",
        reason: "ReadOnlyAccess is an AWS managed policy used for switch role demonstration.",
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/ReadOnlyAccess',
        ],
      },
    ],
    true,
  );

}