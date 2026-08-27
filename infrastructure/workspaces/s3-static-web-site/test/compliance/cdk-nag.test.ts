import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

import { S3StaticWebSiteStack } from 'lib/stacks/s3-static-web-site-stack';
import { params } from 'parameters/environments';
import '../parameters'; // registers test-params into `params` as a side effect

const defaultEnv = {
  account: '123456789012',
  region: 'ap-northeast-1',
};

const projectName = 'example';
const envName: Environment = Environment.TEST;
if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

describe('CDK Nag AwsSolutions Pack', () => {
  let app: cdk.App;
  let stack: S3StaticWebSiteStack;

  beforeAll(() => {
    app = new cdk.App();

    stack = new S3StaticWebSiteStack(app, `${projectName}-${envName}`, {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: false,
      terminationProtection: false,
      envParams,
      allowedIps: ['203.0.113.10'],
      allowedIpv6s: ['2001:db8::1'],
    });

    // Apply suppressions (must be applied before adding Aspects)
    applySuppressions(stack);

    // Run CDK Nag
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  });

  test('No unsuppressed Warnings', () => {
    const warnings = Annotations.fromStack(stack).findWarning(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*'),
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
      Match.stringLikeRegexp('AwsSolutions-.*'),
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

  test('Creates the website bucket and its dedicated access-log bucket', () => {
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::S3::Bucket', 2);
  });
});

/**
 * Apply CDK Nag suppressions to the stack.
 *
 * Best Practices:
 * 1. Apply suppressions to specific resource paths whenever possible (addResourceSuppressionsByPath)
 * 2. Minimize stack-wide suppressions (addStackSuppressions)
 * 3. Use appliesTo when there are multiple specific issues with the same resource
 * 4. Provide clear and specific reasons
 *
 * Every suppression below is a deliberate property of this reference architecture (an S3
 * website-endpoint site fronted only by a source-IP allowlist), not a finding left unaddressed.
 */
function applySuppressions(stack: S3StaticWebSiteStack): void {
  const pathPrefix = `/${stack.stackName}`;

  NagSuppressions.addResourceSuppressionsByPath(stack, `${pathPrefix}/AccessLogBucket/Resource`, [
    {
      id: 'AwsSolutions-S1',
      reason:
        'AccessLogBucket is itself the destination for the website bucket\'s S3 server access logs; ' +
        'enabling server access logging on it would only produce logs about logs with no additional ' +
        'observability value.',
    },
  ]);

  // S10: the S3 static website endpoint only serves plain HTTP, so a deny-non-TLS bucket policy
  // (enforceSSL) would reject every website request. TLS termination belongs in front of the
  // bucket (e.g. CloudFront) in a production deployment. cdk-nag evaluates this against both the
  // bucket and its generated Policy resource, so both paths are suppressed.
  const s10Suppression = {
    id: 'AwsSolutions-S10',
    reason:
      'The S3 static website endpoint only serves plain HTTP; enforcing aws:SecureTransport would ' +
      'reject every website request. Front the bucket with CloudFront to terminate TLS in production.',
  };
  NagSuppressions.addResourceSuppressionsByPath(stack, `${pathPrefix}/WebsiteBucket/Resource`, [
    {
      id: 'AwsSolutions-S5',
      reason:
        'This reference architecture intentionally serves content directly from the S3 website ' +
        'endpoint and limits access with an explicit source-IP allowlist instead of a CloudFront ' +
        'Origin Access Identity. The CloudFront + OAI variant is covered by the ' +
        'cloudfront-s3-static-website workspace.',
    },
    s10Suppression,
  ]);
  NagSuppressions.addResourceSuppressionsByPath(stack, `${pathPrefix}/WebsiteBucket/Policy/Resource`, [
    s10Suppression,
  ]);
}
