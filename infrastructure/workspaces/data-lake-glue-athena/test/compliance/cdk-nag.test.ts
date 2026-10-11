import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

import { DataLakeGlueAthenaStack } from 'lib/stacks/data-lake-glue-athena-stack';
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
  let stack: DataLakeGlueAthenaStack;

  beforeAll(() => {
    // Execute CDK Nag checks
    app = new cdk.App();

    stack = new DataLakeGlueAthenaStack(app, `${projectName}-${envName}`, {
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
function applySuppressions(stack: DataLakeGlueAthenaStack): void {
  //console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);

  NagSuppressions.addStackSuppressions(
    stack,
    [
      { id: 'AwsSolutions-S1', reason: 'The zone buckets hold a reference dataset; server access logs would need another bucket that itself needs logging.' },
      { id: 'AwsSolutions-IAM4', reason: 'AWSGlueServiceRole is the AWS-managed policy documented for Glue crawlers and jobs; the S3 auto-delete provider role uses a managed logging policy.' },
      { id: 'AwsSolutions-IAM5', reason: 'The Glue role reads and writes objects of the zone buckets (bucket/*) and Glue and CloudWatch Logs resources it creates at run time.' },
      { id: 'AwsSolutions-L1', reason: 'The auto-delete provider runtime is managed by CDK.' },
      { id: 'AwsSolutions-GL1', reason: 'No security configuration is attached; objects are encrypted by the S3-managed default and the job logs hold no data values.' },
      { id: 'AwsSolutions-GL3', reason: 'The job bookmark option is not used: the job rewrites the partitions of its input, which is idempotent.' },
      { id: 'AwsSolutions-ATH1', reason: 'Query results are encrypted with SSE-S3 and enforced by the workgroup; SSE-KMS would add a key whose permissions every analyst needs.' },
    ],
    true,
  );

}
