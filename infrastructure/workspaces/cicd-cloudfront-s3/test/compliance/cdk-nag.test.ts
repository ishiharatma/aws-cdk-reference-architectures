import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

import { CicdCloudfrontS3Stack } from 'lib/stacks/cicd-cloudfront-s3-stack';
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
  let stack: CicdCloudfrontS3Stack;

  beforeAll(() => {
    // Execute CDK Nag checks
    app = new cdk.App();

    stack = new CicdCloudfrontS3Stack(app, `${projectName}-${envName}`, {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: false,
      terminationProtection: false,
      env: defaultEnv,
      envParams: envParams,
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
function applySuppressions(stack: CicdCloudfrontS3Stack): void {
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
    ],
    true,
  );

  // Lambda execution roles use the AWS-managed AWSLambdaBasicExecutionRole for
  // CloudWatch Logs write access. Acceptable for these demonstration functions.
  for (const lambdaId of ['S3SyncLambda', 'CloudfrontInvalidationLambda']) {
    NagSuppressions.addResourceSuppressionsByPath(
      stack,
      `${pathPrefix}/${lambdaId}/ServiceRole/Resource`,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is used for CloudWatch Logs write access in this demonstration stack.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
      ],
    );

    // CodePipeline's LambdaInvokeAction grants codepipeline:PutJobSuccessResult/PutJobFailureResult
    // to the function's own role; these CodePipeline job-result APIs do not support resource-level scoping.
    NagSuppressions.addResourceSuppressionsByPath(
      stack,
      `${pathPrefix}/${lambdaId}/ServiceRole/DefaultPolicy/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'codepipeline:PutJobSuccessResult/PutJobFailureResult do not support resource-level permissions and require a wildcard resource.',
          appliesTo: ['Resource::*'],
        },
      ],
    );
  }

  // CodeBuild project does not use a customer-managed KMS key for build artifact encryption;
  // the default AWS-managed encryption is acceptable for this demonstration static-site build.
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/BuildProject/Resource`,
    [
      {
        id: 'AwsSolutions-CB4',
        reason: 'Default AWS-managed encryption is acceptable for this demonstration build project; use a customer-managed KMS key in production.',
      },
    ],
  );

  // CDK-generated DefaultPolicy for the CodeBuild role: log group and report group ARNs
  // are suffixed with a wildcard because CodeBuild appends stream/report identifiers at
  // runtime, and CodeBuildAction.bind() also grants the project read/write access to the
  // pipeline's artifact bucket (object-level bucket/* wildcard).
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/BuildProject/Role/DefaultPolicy/Resource`,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CodeBuild requires wildcarded log-group/report-group resources (runtime-appended identifiers) and CDK\'s standard S3 grantRead/grantWrite action+bucket/* wildcards for its CDK-granted artifact bucket access.',
      },
    ],
  );

  // The pipeline's auto-created role is granted read/write on the artifact bucket by the
  // Pipeline construct itself; S3 object-level actions require the bucket/* wildcard.
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/Pipeline/Role/DefaultPolicy/Resource`,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CDK-generated artifact bucket read/write grant for the pipeline role requires the bucket/* wildcard for S3 object-level actions.',
      },
    ],
  );

  // Each per-action CodePipeline role (Source/Deploy/Sync/InvalidateCache) receives CDK's
  // standard auto-granted, action-scoped permissions: artifact bucket object-level access,
  // the deployment target bucket for S3DeployAction, lambda:ListFunctions (required wildcard
  // action), and invoke permissions on the specific Lambda function (with a :* version/alias
  // suffix). These are generated by the CDK L2 action constructs, not hand-written.
  for (const actionPath of [
    'Source/CodeCommit_Source',
    'Deploy/S3_Deploy',
    'Sync/Lambda_S3_Sync',
    'InvalidateCache/Lambda_CloudFront_Invalidate',
  ]) {
    NagSuppressions.addResourceSuppressionsByPath(
      stack,
      `${pathPrefix}/Pipeline/${actionPath}/CodePipelineActionRole/DefaultPolicy/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK auto-grants action-scoped, wildcarded permissions (bucket/* object access, lambda:ListFunctions, and versioned Lambda ARNs) for this CodePipeline action; these are generated by the CDK L2 action constructs.',
        },
      ],
    );
  }
}
