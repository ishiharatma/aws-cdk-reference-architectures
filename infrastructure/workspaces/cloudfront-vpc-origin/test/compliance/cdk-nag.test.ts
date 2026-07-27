import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

import { CloudfrontVpcOriginStack } from 'lib/stacks/cloudfront-vpc-origin-stack';
import { CloudfrontMonitoringStack } from 'lib/stacks/cloudfront-monitoring-stack';
import { params } from "parameters/environments";
import '../parameters';
import { getMyGlobalIp } from '@common/helpers/get-my-ip';
import { pascalCase } from 'change-case-commonjs';

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
  let stack: CloudfrontVpcOriginStack;

  beforeAll(() => {
    // Execute CDK Nag checks
    app = new cdk.App();

    stack = new CloudfrontVpcOriginStack(app, pascalCase(`${projectName}-${envName}`), {
      project: projectName,
      description: `${pascalCase(projectName)} Cloudfront Basic Stack for ${envName}`,
      environment: envName,
      vpcConfig: envParams.vpcConfig,
      allowedCloudFunctionIps: [getMyGlobalIp()],
      env: defaultEnv,
      terminationProtection: false, 
      isAutoDeleteObject: false,
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

describe('CDK Nag AwsSolutions Pack (publicAlbFailover enabled)', () => {
  let app: cdk.App;
  let stack: CloudfrontVpcOriginStack;

  beforeAll(() => {
    app = new cdk.App();

    stack = new CloudfrontVpcOriginStack(app, pascalCase(`${projectName}-${envName}-failover`), {
      project: projectName,
      description: `${pascalCase(projectName)} Cloudfront Basic Stack for ${envName} (publicAlbFailover)`,
      environment: envName,
      vpcConfig: envParams.vpcConfig,
      allowedCloudFunctionIps: [getMyGlobalIp()],
      cloudfrontManagedPrefixList: 'pl-58a04531',
      publicAlbFailover: { enabled: true },
      env: defaultEnv,
      terminationProtection: false,
      isAutoDeleteObject: false,
    });

    applySuppressions(stack);
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  });

  test('No unsuppressed Warnings', () => {
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(warnings).toHaveLength(0);
  });

  test('No unsuppressed Errors', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors).toHaveLength(0);
  });
});

describe('CDK Nag AwsSolutions Pack (CloudfrontMonitoringStack)', () => {
  let app: cdk.App;
  let stack: CloudfrontMonitoringStack;

  beforeAll(() => {
    app = new cdk.App();

    stack = new CloudfrontMonitoringStack(app, pascalCase(`${projectName}-${envName}-monitoring`), {
      project: projectName,
      environment: envName,
      distributionId: 'E1EXAMPLE12345',
      alarmEmail: 'ops@example.com',
      env: { account: defaultEnv.account, region: 'us-east-1' },
      terminationProtection: false,
    });

    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  });

  test('No unsuppressed Warnings', () => {
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(warnings).toHaveLength(0);
  });

  test('No unsuppressed Errors', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
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
function applySuppressions(stack: CloudfrontVpcOriginStack): void {
  const stackName = stack.stackName;
  //console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);
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
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is an accepted baseline for Lambda functions in this sample.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
    ],
    true,
  );

  // The CloudFront distribution uses the default *.cloudfront.net certificate (no
  // Route53-hosted custom domain in this sample), which forces CloudFront to allow
  // TLSv1 regardless of `minimumProtocolVersion`. Not fixable without a custom domain + ACM cert.
  // WAF integration is intentionally out of scope for this "basic" reference pattern.
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/Distribution/Resource`,
    [
      {
        id: 'AwsSolutions-CFR4',
        reason: 'Distribution uses the default CloudFront certificate (no custom domain in this sample); TLSv1 is enforced by CloudFront regardless of minimumProtocolVersion in that case.',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason: 'WAF integration is out of scope for this basic reference pattern.',
      },
      {
        id: 'AwsSolutions-CFR5',
        reason: 'The ALB origin only listens on HTTP (port 80). This applies both to the VPC Origin ' +
          '(not flagged by this rule, which only inspects CustomOriginConfig) and, when the ' +
          'publicAlbFailover incident-response escape hatch is enabled, the plain public HTTP ' +
          'origin that replaces it — TLS to the origin is out of scope for this reference pattern.',
      },
    ],
  );

  // The ALB security group's ingress CIDR is a token (the VPC's own CIDR block, referenced via
  // Fn::GetAtt), which cdk-nag's EC23 rule can't resolve to a literal value to check for
  // overly-permissive ranges. It's the VPC's own CIDR, scoped to CloudFront VPC origin traffic.
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/AlbSecurityGroup/Resource`,
    [
      {
        id: 'AwsSolutions-EC23',
        reason: 'The ingress CIDR is the VPC\'s own CIDR block (a token cdk-nag cannot resolve), used to allow CloudFront VPC origin ENI traffic from inside the VPC.',
      },
    ],
  );

  // The BucketDeployment L2 construct (aws-s3-deployment) auto-generates its own Lambda,
  // role and wildcard S3 policy to sync arbitrary asset content; this is AWS-managed code
  // that isn't directly customizable from this stack.
  stack.node.findAll().forEach((child) => {
    if (child.node.id.startsWith('Custom::CDKBucketDeployment')) {
      NagSuppressions.addResourceSuppressions(
        child,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason: 'Wildcard S3 permissions are generated internally by the CDK BucketDeployment construct to sync arbitrary asset content to the destination bucket.',
          },
          {
            id: 'AwsSolutions-L1',
            reason: 'Runtime is fixed by the aws-s3-deployment module bundled with the installed aws-cdk-lib version and is not directly controllable from this stack.',
          },
        ],
        true,
      );
    }
  });
}
