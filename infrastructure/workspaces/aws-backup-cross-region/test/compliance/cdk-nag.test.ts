import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { AwsBackupCrrOsakaStack } from 'lib/stacks/aws-backup-crr-osaka-stack';
import { AwsBackupCrrTokyoStack } from 'lib/stacks/aws-backup-crr-tokyo-stack';
import { SampleAppStack } from 'lib/stacks/sample-app-stack';
import { params } from 'parameters/environments';
import '../parameters';

const tokyoEnv = { account: '123456789012', region: 'ap-northeast-1' };
const osakaEnv = { account: '123456789012', region: 'ap-northeast-3' };

const projectName = 'example';
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const destinationVaultName = `${projectName}-${envName}-backup-osaka`;

describe('CDK Nag AwsSolutions Pack', () => {
    let app: cdk.App;
    let osakaStack: AwsBackupCrrOsakaStack;
    let sampleAppStack: SampleAppStack;
    let tokyoStack: AwsBackupCrrTokyoStack;

    beforeAll(() => {
        app = new cdk.App();

        osakaStack = new AwsBackupCrrOsakaStack(app, `${projectName}-${envName}-osaka`, {
            project: projectName,
            environment: envName,
            env: osakaEnv,
            params: envParams,
            vaultName: destinationVaultName,
        });

        sampleAppStack = new SampleAppStack(app, `${projectName}-${envName}-sample-app`, {
            project: projectName,
            environment: envName,
            env: tokyoEnv,
            params: envParams,
            isAutoDeleteObject: true,
        });

        tokyoStack = new AwsBackupCrrTokyoStack(app, `${projectName}-${envName}-tokyo`, {
            project: projectName,
            environment: envName,
            env: tokyoEnv,
            params: envParams,
            isAutoDeleteObject: true,
            destinationRegion: 'ap-northeast-3',
            destinationVaultName,
        });

        // Apply suppressions (must be applied before adding Aspects)
        applyCommonSuppressions(osakaStack);
        applyCommonSuppressions(sampleAppStack);
        applyCommonSuppressions(tokyoStack);
        applyTokyoWorkloadSuppressions(tokyoStack);

        cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test.each([
        ['Osaka', () => osakaStack],
        ['SampleApp', () => sampleAppStack],
        ['Tokyo', () => tokyoStack],
    ])('%s stack: no unsuppressed Warnings', (_name, getStack) => {
        const warnings = Annotations.fromStack(getStack()).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
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

    test.each([
        ['Osaka', () => osakaStack],
        ['SampleApp', () => sampleAppStack],
        ['Tokyo', () => tokyoStack],
    ])('%s stack: no unsuppressed Errors', (_name, getStack) => {
        const errors = Annotations.fromStack(getStack()).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
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
 * Suppressions shared by every stack in this pattern.
 *
 * Best Practices:
 * 1. Apply suppressions to specific resource paths whenever possible (addResourceSuppressionsByPath)
 * 2. Minimize stack-wide suppressions (addStackSuppressions)
 * 3. Use appliesTo when there are multiple specific issues with the same resource
 * 4. Provide clear and specific reasons
 */
function applyCommonSuppressions(stack: cdk.Stack): void {
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-S1',
                reason: 'These are example S3 buckets for demonstration and do not require server access logging.',
            },
        ],
        true,
    );
}

/**
 * Suppressions specific to the sample VPC/EC2/RDS workload and the AWS Backup service role in
 * AwsBackupCrrTokyoStack. AWS Backup itself has no dedicated cdk-nag rule pack as of this
 * writing; these suppressions cover the sample workload standing in for "the application
 * being backed up", not the backup configuration itself.
 */
function applyTokyoWorkloadSuppressions(stack: cdk.Stack): void {
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-IAM4',
                reason:
                    'AWS Backup has no customer-manageable equivalent to service-role/AWSBackupServiceRolePolicyForBackup ' +
                    'and service-role/AWSBackupServiceRolePolicyForRestores — these AWS-managed policies are the ' +
                    'documented way to grant the Backup service permission to back up and restore resources.',
            },
            {
                id: 'AwsSolutions-EC28',
                reason: 'Sample EC2 instance for this reference architecture; detailed monitoring is not required to demonstrate the backup pattern.',
            },
            {
                id: 'AwsSolutions-EC29',
                reason: 'Sample EC2 instance for this reference architecture must remain destroyable, so termination protection is intentionally disabled.',
            },
            {
                id: 'AwsSolutions-RDS10',
                reason: 'Sample RDS instance for this reference architecture must remain destroyable, so deletion protection is intentionally disabled.',
            },
            {
                id: 'AwsSolutions-RDS11',
                reason: 'Sample RDS instance uses the default MySQL port for simplicity; this is a demo workload, not a production database.',
            },
            {
                id: 'AwsSolutions-SMG4',
                reason: 'The generated RDS credential secret does not need automatic rotation for this reference architecture demo.',
            },
            {
                id: 'AwsSolutions-RDS3',
                reason: 'Sample RDS instance for this reference architecture is intentionally single-AZ to minimize cost; AWS Backup (this pattern\'s subject) provides the durability story here, not RDS Multi-AZ.',
            },
            {
                id: 'AwsSolutions-EC23',
                reason:
                    'Security group ingress rules restrict access to the VPC\'s own CIDR block, referenced via an intrinsic ' +
                    "function (Fn::GetAtt) that cdk-nag's EC23 rule cannot resolve to a literal value to validate — this is a " +
                    'known cdk-nag limitation, not an open (0.0.0.0/0) rule.',
            },
            {
                id: 'AwsSolutions-IAM5',
                appliesTo: ['Resource::*'],
                reason:
                    "CDK's built-in LogRetention custom resource (created by ec2.Vpc's flow log LogGroup) requires " +
                    'wildcard permissions to manage the retention policy of a log group whose name is only known at deploy ' +
                    'time — this is inherent to the L1 custom resource, not a permission this workspace can scope further.',
            },
        ],
        true,
    );
}
