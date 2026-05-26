import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { CloudwatchLogsS3ArchiveBasicStack } from 'lib/stacks/cloudwatch-logs-s3-archive-basic-stack';
import { CloudwatchLogsS3ArchiveLifecycleStack } from 'lib/stacks/cloudwatch-logs-s3-archive-lifecycle-stack';
import { CloudwatchLogsS3ArchiveExistingStack } from 'lib/stacks/cloudwatch-logs-s3-archive-existing-stack';
import { CloudwatchLogsS3ArchiveExportStack } from 'lib/stacks/cloudwatch-logs-s3-archive-export-stack';
import { CloudwatchLogsS3ArchiveLambdaStack } from 'lib/stacks/cloudwatch-logs-s3-archive-lambda-stack';
import { params } from 'parameters/environments';
import 'test/parameters';
import * as path from 'path';
import { loadCdkContext } from '@common/test-helpers/test-context';

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
const cdkJsonPath = path.resolve(__dirname, '../../cdk.json');
const baseContext = loadCdkContext(cdkJsonPath);

function nagTestSuite(
    suiteName: string,
    buildStack: (app: cdk.App) => cdk.Stack,
    suppressFn: (stack: cdk.Stack) => void,
) {
    describe(`CDK Nag AwsSolutions Pack – ${suiteName}`, () => {
        let app: cdk.App;
        let stack: cdk.Stack;

        beforeAll(() => {
            app = new cdk.App({ context: baseContext });
            stack = buildStack(app);
            suppressFn(stack);
            cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
        });

        test('No unsuppressed Warnings', () => {
            const warnings = Annotations.fromStack(stack).findWarning(
                '*',
                Match.stringLikeRegexp('AwsSolutions-.*'),
            );
            if (warnings.length > 0) {
                console.log('\n=== CDK Nag Warnings ===');
                warnings.forEach((w, i) => {
                    console.log(`\nWarning ${i + 1}:`);
                    console.log(`  Path: ${w.id}`);
                    console.log(`  Entry:`, JSON.stringify(w.entry, null, 2));
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
            if (errors.length > 0) {
                console.log('\n=== CDK Nag Errors ===');
                errors.forEach((e, i) => {
                    console.log(`\nError ${i + 1}:`);
                    console.log(`  Path: ${e.id}`);
                    console.log(`  Entry:`, JSON.stringify(e.entry, null, 2));
                });
                console.log('======================\n');
            }
            expect(errors).toHaveLength(0);
        });
    });
}

/**
 * Common cdk-nag suppressions shared by all three stacks.
 *
 * Best Practices:
 * 1. Prefer addResourceSuppressionsByPath over addStackSuppressions where possible
 * 2. Supply a clear reason for every suppression
 * 3. Omit `appliesTo` when the CDK-generated logical ID is not deterministic across
 *    stack instances; this suppresses all findings of the rule for that resource path.
 */
function applyCommonSuppressions(stack: cdk.Stack): void {
    const stackName = stack.stackName;
    const pathPrefix = `/${stackName}`;

    // S3 server-access logging is omitted in these demo stacks
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-S1',
                reason: 'Server-access logging is not required for these demonstration archive buckets.',
            },
        ],
        true,
    );

    // FirehoseRole inline policy grants s3:PutObject on bucket/* which triggers IAM5.
    // The bucket ARN wildcard (/*) is intentional and required for Firehose to write objects.
    NagSuppressions.addResourceSuppressionsByPath(
        stack,
        `${pathPrefix}/FirehoseRole/Resource`,
        [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Firehose requires s3:PutObject and related actions on the archive bucket wildcard path (bucket/*) to deliver log records. The specific bucket is identified by its ARN.',
            },
        ],
    );

    // CDK may inject a DefaultPolicy onto the FirehoseRole for additional S3/CWL
    // wildcard permissions needed at runtime by Kinesis Data Firehose.
    NagSuppressions.addResourceSuppressionsByPath(
        stack,
        `${pathPrefix}/FirehoseRole/DefaultPolicy/Resource`,
        [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'CDK-generated DefaultPolicy on the Firehose role uses wildcards for S3 sub-path and CloudWatch Logs stream operations that are required by Kinesis Data Firehose at runtime.',
            },
        ],
    );
}

// ============================================================================
// Stack 1: Basic
// ============================================================================
nagTestSuite(
    'CloudwatchLogsS3ArchiveBasicStack',
    (app) =>
        new CloudwatchLogsS3ArchiveBasicStack(app, `${projectName}-${envName}-basic`, {
            project: projectName,
            environment: envName,
            isAutoDeleteObject: false,
            terminationProtection: false,
            env: defaultEnv,
            params: envParams,
        }),
    applyCommonSuppressions,
);

// ============================================================================
// Stack 2: Lifecycle
// ============================================================================
nagTestSuite(
    'CloudwatchLogsS3ArchiveLifecycleStack',
    (app) =>
        new CloudwatchLogsS3ArchiveLifecycleStack(app, `${projectName}-${envName}-lifecycle`, {
            project: projectName,
            environment: envName,
            isAutoDeleteObject: false,
            terminationProtection: false,
            env: defaultEnv,
            params: envParams,
        }),
    applyCommonSuppressions,
);

// ============================================================================
// Stack 3: Existing Log Group
// ============================================================================
nagTestSuite(
    'CloudwatchLogsS3ArchiveExistingStack',
    (app) =>
        new CloudwatchLogsS3ArchiveExistingStack(app, `${projectName}-${envName}-existing`, {
            project: projectName,
            environment: envName,
            isAutoDeleteObject: false,
            terminationProtection: false,
            env: defaultEnv,
            params: envParams,
        }),
    applyCommonSuppressions,
);

// ============================================================================
// Stack 4: Export Task (Pattern B)
// ============================================================================
function applyExportSuppressions(stack: cdk.Stack): void {
    const stackName = stack.stackName;
    const pathPrefix = `/${stackName}`;

    // S3 server-access logging is omitted in these demo stacks
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-S1',
                reason: 'Server-access logging is not required for these demonstration archive buckets.',
            },
        ],
        true,
    );

    // Lambda execution role uses AWSLambdaBasicExecutionRole managed policy.
    // For this demonstration stack the managed policy is acceptable; a production
    // deployment should use a custom policy with only the required log-write actions.
    NagSuppressions.addResourceSuppressionsByPath(
        stack,
        `${pathPrefix}/ExportTaskFunction/ServiceRole/Resource`,
        [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWSLambdaBasicExecutionRole is used for CloudWatch Logs write access in this demonstration stack.',
                appliesTo: [
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                ],
            },
        ],
    );

    // The Lambda execution role's DefaultPolicy grants logs:CreateExportTask and
    // logs:DescribeExportTasks on '*' because the CloudWatch Logs API does not
    // support resource-level permissions for these two actions.
    NagSuppressions.addResourceSuppressionsByPath(
        stack,
        `${pathPrefix}/ExportTaskFunction/ServiceRole/DefaultPolicy/Resource`,
        [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'logs:CreateExportTask and logs:DescribeExportTasks do not support resource-level permissions; the wildcard resource is required by the CloudWatch Logs API.',
            },
        ],
    );

    // Python 3.12 is the latest stable Python runtime available in Lambda at the
    // time this stack was authored.  The cdk-nag AwsSolutions-L1 rule may flag
    // it if the installed cdk-nag package was built against an older runtime list.
    NagSuppressions.addResourceSuppressionsByPath(
        stack,
        `${pathPrefix}/ExportTaskFunction/Resource`,
        [
            {
                id: 'AwsSolutions-L1',
                reason: 'Python 3.12 is the latest available Python runtime for Lambda at the time of authoring; the cdk-nag package in this workspace may not yet recognise it as the latest.',
            },
        ],
    );
}

nagTestSuite(
    'CloudwatchLogsS3ArchiveExportStack',
    (app) =>
        new CloudwatchLogsS3ArchiveExportStack(app, `${projectName}-${envName}-export`, {
            project: projectName,
            environment: envName,
            isAutoDeleteObject: false,
            terminationProtection: false,
            env: defaultEnv,
            params: envParams,
        }),
    applyExportSuppressions,
);

// ============================================================================
// Stack 5: Lambda Direct Write (Pattern C)
// ============================================================================
function applyLambdaSuppressions(stack: cdk.Stack): void {
    const stackName = stack.stackName;
    const pathPrefix = `/${stackName}`;

    // S3 server-access logging is omitted in these demo stacks
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-S1',
                reason: 'Server-access logging is not required for these demonstration archive buckets.',
            },
        ],
        true,
    );

    // Lambda execution role uses AWSLambdaBasicExecutionRole managed policy.
    // For this demonstration stack the managed policy is acceptable; a production
    // deployment should use a custom policy with only the required log-write actions.
    NagSuppressions.addResourceSuppressionsByPath(
        stack,
        `${pathPrefix}/ArchiveFunction/ServiceRole/Resource`,
        [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWSLambdaBasicExecutionRole is used for CloudWatch Logs write access in this demonstration stack.',
                appliesTo: [
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                ],
            },
        ],
    );

    // grantWrite() on the archive bucket produces a DefaultPolicy with s3:PutObject
    // and related actions scoped to bucket/* (the object path wildcard is intentional
    // and required for the Lambda to write log files anywhere within the bucket).
    NagSuppressions.addResourceSuppressionsByPath(
        stack,
        `${pathPrefix}/ArchiveFunction/ServiceRole/DefaultPolicy/Resource`,
        [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'The S3 grantWrite wildcard (bucket/*) is intentional: the Lambda writes log objects to date-partitioned keys under a configurable prefix and cannot predict the full key at deploy time.',
            },
        ],
    );

    // Python 3.12 is the latest stable Python runtime available in Lambda at the
    // time this stack was authored.  The cdk-nag AwsSolutions-L1 rule may flag
    // it if the installed cdk-nag package was built against an older runtime list.
    NagSuppressions.addResourceSuppressionsByPath(
        stack,
        `${pathPrefix}/ArchiveFunction/Resource`,
        [
            {
                id: 'AwsSolutions-L1',
                reason: 'Python 3.12 is the latest available Python runtime for Lambda at the time of authoring; the cdk-nag package in this workspace may not yet recognise it as the latest.',
            },
        ],
    );
}

nagTestSuite(
    'CloudwatchLogsS3ArchiveLambdaStack',
    (app) =>
        new CloudwatchLogsS3ArchiveLambdaStack(app, `${projectName}-${envName}-lambda`, {
            project: projectName,
            environment: envName,
            isAutoDeleteObject: false,
            terminationProtection: false,
            env: defaultEnv,
            params: envParams,
        }),
    applyLambdaSuppressions,
);
