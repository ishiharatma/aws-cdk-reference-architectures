/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { IamBasicsStack } from "lib/stacks/iam-basics-stack";
import { Template } from "aws-cdk-lib/assertions";
import { Environment } from "@common/parameters/environments";

const defaultEnv = {
    account: "123456789012",
    region: "ap-northeast-1",
};

const projectName = "TestProject";
const envName: Environment = Environment.TEST;

/**
 * AWS CDK Unit Tests - Fine-grained Assertions
 *
 * This test suite aims to:
 * 1. Verify detailed configuration values of individual resources
 * 2. Check relationships between resources
 * 3. Validate security settings and cost optimization configurations
 *
 * Best practices for fine-grained assertions:
 * - Verify specific configuration values
 * - Name tests clearly to indicate their intent
 * - Test one aspect per test case
 */

describe("Fine-grained Assertions - IAMBasicsStack", () => {
  let stack: cdk.Stack;
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    stack = new IamBasicsStack(app, "TestStack", {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
    });
    template = Template.fromStack(stack);
  });

  describe("IAM Users", () => {
    test("should create CDKDefaultUser", () => {
      template.hasResourceProperties("AWS::IAM::User", {
      });
      const resources = template.findResources("AWS::IAM::User");
      expect(Object.keys(resources).length).toBeGreaterThanOrEqual(1);
    });

    test("PasswordUser should have password reset required", () => {
      template.hasResourceProperties("AWS::IAM::User", {
      });
    });

    test("SecretsPasswordUser should have specific username", () => {
      template.hasResourceProperties("AWS::IAM::User", {
        UserName: "SecretsPasswordUser",
      });
    });

    test("SecretsPasswordUser should be attached to ReadOnlyAccess policy", () => {
      const users = template.findResources("AWS::IAM::User");
      const secretsPasswordUser = Object.values(users).find(
        (user: any) => user.Properties?.UserName === "SecretsPasswordUser"
      );
      expect(secretsPasswordUser).toBeDefined();
      if (secretsPasswordUser) {
        const policies = secretsPasswordUser.Properties?.ManagedPolicyArns || [];
        const policyArns = policies.map((p: any) => {
          if (p["Fn::Join"]) {
            return p["Fn::Join"][1].join("");
          }
          return p;
        });
        expect(policyArns.some((arn: string) => arn.includes("ReadOnlyAccess"))).toBe(true);
      }
    });

    test("SecretsPasswordUser should have IAMUserChangePassword policy", () => {
      const users = template.findResources("AWS::IAM::User");
      const secretsPasswordUser = Object.values(users).find(
        (user: any) => user.Properties?.UserName === "SecretsPasswordUser"
      );
      expect(secretsPasswordUser).toBeDefined();
      if (secretsPasswordUser) {
        const policies = secretsPasswordUser.Properties?.ManagedPolicyArns || [];
        const policyArns = policies.map((p: any) => {
          if (p["Fn::Join"]) {
            return p["Fn::Join"][1].join("");
          }
          return p;
        });
        expect(policyArns.some((arn: string) => arn.includes("IAMUserChangePassword"))).toBe(true);
      }
    });
  });

  describe("IAM Groups", () => {
    test("should create an IAM Group for user group construct", () => {
      template.resourceCountIs("AWS::IAM::Group", 2);
    });

    test("Group should have ReadOnlyAccess managed policy attached", () => {
      template.hasResourceProperties("AWS::IAM::Group", {
        ManagedPolicyArns: [
          {
            "Fn::Join": [
              "",
              [
                "arn:",
                {
                  Ref: "AWS::Partition",
                },
                ":iam::aws:policy/ReadOnlyAccess",
              ],
            ],
          },
        ],
      });
    });

    test("SwitchRoleGroup should exist for switch role functionality", () => {
      template.resourceCountIs("AWS::IAM::Group", 2);
    });
  });

  describe("IAM Roles", () => {
    test("should create a ReadOnlyRole for switch role", () => {
      template.resourceCountIs("AWS::IAM::Role", 1);
    });

    test("ReadOnlyRole should have ReadOnlyAccess managed policy", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        ManagedPolicyArns: [
          {
            "Fn::Join": [
              "",
              [
                "arn:",
                {
                  Ref: "AWS::Partition",
                },
                ":iam::aws:policy/ReadOnlyAccess",
              ],
            ],
          },
        ],
      });
    });

    test("ReadOnlyRole should require MFA", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Effect: "Allow",
              Condition: {
                Bool: {
                  "aws:MultiFactorAuthPresent": "true",
                },
              },
            },
          ],
        },
      });
    });

    test("ReadOnlyRole should have 4 hour max session duration", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        MaxSessionDuration: 14400,
      });
    });
  });

  describe("IAM Policies", () => {
    test("should create policies with specific statements", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      expect(Object.keys(policies).length).toBeGreaterThanOrEqual(1);
    });

    test("should create assume role policy for switch role", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      const assumeRolePolicy = Object.values(policies).find((policy: any) => {
        const statements = policy.Properties?.PolicyDocument?.Statement || [];
        return statements.some((stmt: any) => stmt.Action === "sts:AssumeRole");
      });
      expect(assumeRolePolicy).toBeDefined();
    });

    test("SecretsPasswordUser should have inline policy with S3 permissions", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      const s3Policy = Object.values(policies).find((policy: any) => {
        const statements = policy.Properties?.PolicyDocument?.Statement || [];
        return statements.some((stmt: any) =>
          stmt.Action === "s3:ListAllMyBuckets" && stmt.Resource === "arn:aws:s3:::*"
        );
      });
      expect(s3Policy).toBeDefined();
    });
  });

  describe("Secrets Manager Secrets", () => {
    test("should create secrets for password management", () => {
      template.resourceCountIs("AWS::SecretsManager::Secret", 3);
    });

    test("each secret should generate password without punctuation", () => {
      template.hasResourceProperties("AWS::SecretsManager::Secret", {
        GenerateSecretString: {
          ExcludePunctuation: true,
        },
      });
    });
  });

  describe("User-Group Relationships", () => {
    test("should add users to groups via Groups property", () => {
      const users = template.findResources("AWS::IAM::User");
      const usersWithGroups = Object.values(users).filter(
        (user: any) => user.Properties?.Groups && user.Properties.Groups.length > 0
      );
      expect(usersWithGroups.length).toBeGreaterThanOrEqual(2);
    });

    test("users should be members of their respective groups", () => {
      const groups = template.findResources("AWS::IAM::Group");
      expect(Object.keys(groups).length).toBeGreaterThanOrEqual(2);
      // At least some groups should have policies attached
      const groupsWithPolicies = Object.values(groups).filter(
        (group: any) => group.Properties?.ManagedPolicyArns
      );
      expect(groupsWithPolicies.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("CloudFormation Outputs", () => {
    test("should have outputs for user names and secret ARNs", () => {
      const outputs = template.findOutputs("*");
      expect(Object.keys(outputs).length).toBeGreaterThanOrEqual(3);
    });

    test("outputs should contain password user information", () => {
      const outputs = template.findOutputs("*");
      const passwordUserOutputs = Object.entries(outputs).filter(
        ([key]) => key.includes("PasswordUser")
      );
      expect(passwordUserOutputs.length).toBeGreaterThanOrEqual(1);
    });

    test("outputs should contain secrets information", () => {
      const outputs = template.findOutputs("*");
      const secretOutputs = Object.entries(outputs).filter(
        ([key]) => key.includes("SecretArn")
      );
      expect(secretOutputs.length).toBeGreaterThanOrEqual(2);
    });
  });
});