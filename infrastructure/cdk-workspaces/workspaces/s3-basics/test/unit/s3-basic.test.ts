/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { S3BasicStack } from "lib/stacks/s3-basics-stack";
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

describe("S3BasicStack Fine-grained Assertions", () => {
  let stackTemplate: Template;
  let bucketName: string;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new S3BasicStack(app, "S3BasicStack", {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
    });
    stackTemplate = Template.fromStack(stack);
    bucketName =
      `${projectName}-${envName}-${defaultEnv.account}-apnortheast1`.toLowerCase();
  });

  test("S3 Buckets are created", () => {
    // Multiple S3 buckets created: Default, AutoDelete, BlockPublicAccess, EncryptionSSEKMSManaged, EncryptionSSEKMSCustomer, LifecycleRules, Versioning
    stackTemplate.resourceCountIs("AWS::S3::Bucket", 7);
  });

  test("S3 Bucket with custom name has correct name", () => {
    stackTemplate.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: bucketName,
    });
  });

  test("S3 Bucket with encryption has KMS managed encryption", () => {
    stackTemplate.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: "aws:kms",
            },
          },
        ],
      },
    });
  });

  test("S3 Bucket with block public access has all blocks enabled", () => {
    stackTemplate.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test("S3 Bucket with versioning has versioning enabled", () => {
    stackTemplate.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: {
        Status: "Enabled",
      },
    });
  });

  test("S3 Bucket has lifecycle configuration defined", () => {
    const buckets = stackTemplate.findResources("AWS::S3::Bucket");
    const bucketsWithLifecycle = Object.values(buckets).filter(
      (bucket: any) => {
        return bucket?.Properties?.LifecycleConfiguration !== undefined;
      },
    );
    // At least 2 buckets should have lifecycle rules
    expect(bucketsWithLifecycle.length).toBeGreaterThanOrEqual(2);
  });

  test("S3 Buckets do not have website configuration", () => {
    const buckets = stackTemplate.findResources("AWS::S3::Bucket");
    Object.values(buckets).forEach((bucket: any) => {
      expect(bucket.Properties?.WebsiteConfiguration).toBeUndefined();
    });
  });
});
