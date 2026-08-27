import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { AwsBackupCrrTokyoStack } from 'lib/stacks/aws-backup-crr-tokyo-stack';
import { params } from 'parameters/environments';
import '../parameters';

const tokyoEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'testproject';
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const destinationVaultName = `${projectName}-${envName}-backup-osaka`;

/**
 * AwsBackupCrrTokyoStack Fine-grained Assertions
 */
describe('AwsBackupCrrTokyoStack', () => {
    let stackTemplate: Template;

    beforeAll(() => {
        const app = new cdk.App();
        const stack = new AwsBackupCrrTokyoStack(app, 'AwsBackupCrrTokyo', {
            project: projectName,
            environment: envName,
            env: tokyoEnv,
            params: envParams,
            isAutoDeleteObject: true,
            destinationRegion: 'ap-northeast-3',
            destinationVaultName,
        });
        stackTemplate = Template.fromStack(stack);
    });

    test('creates exactly one primary backup vault', () => {
        stackTemplate.resourceCountIs('AWS::Backup::BackupVault', 1);
    });

    test('primary vault uses the deterministic shared name', () => {
        stackTemplate.hasResourceProperties('AWS::Backup::BackupVault', {
            BackupVaultName: `${projectName}-${envName}-backup-tokyo`,
        });
    });

    test('creates exactly one backup plan with a daily rule copying into the Osaka vault', () => {
        stackTemplate.resourceCountIs('AWS::Backup::BackupPlan', 1);

        const templateJson = stackTemplate.toJSON();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const plan: any = Object.values(templateJson.Resources).find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (resource: any) => resource.Type === 'AWS::Backup::BackupPlan',
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dailyRule = plan.Properties.BackupPlan.BackupPlanRule.find((rule: any) => rule.RuleName === 'DailyBackup');
        expect(dailyRule.Lifecycle).toEqual({ DeleteAfterDays: 35 });

        const copyAction = dailyRule.CopyActions[0];
        expect(copyAction.Lifecycle).toEqual({ DeleteAfterDays: 90 });

        // The destination vault ARN is built deterministically (region/account/name — see
        // AwsBackupCrrTokyoStack). Depending on how CDK resolves the account partition it may
        // synthesize as a literal string or an Fn::Join; either way every static ARN segment
        // must appear in the synthesized value.
        const arnValue = JSON.stringify(copyAction.DestinationBackupVaultArn);
        expect(arnValue).toContain('ap-northeast-3');
        expect(arnValue).toContain('backup-vault');
        expect(arnValue).toContain(destinationVaultName);
    });

    test('creates exactly one tag-based backup selection scoped to the configured tag', () => {
        stackTemplate.resourceCountIs('AWS::Backup::BackupSelection', 1);
        stackTemplate.hasResourceProperties('AWS::Backup::BackupSelection', {
            BackupSelection: Match.objectLike({
                ListOfTags: Match.arrayWith([
                    Match.objectLike({
                        ConditionKey: 'Backup',
                        ConditionValue: 'true',
                        ConditionType: 'STRINGEQUALS',
                    }),
                ]),
            }),
        });
    });

    test('backup role is assumable by the backup service', () => {
        stackTemplate.hasResourceProperties('AWS::IAM::Role', {
            AssumeRolePolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Principal: { Service: 'backup.amazonaws.com' },
                    }),
                ]),
            }),
        });
    });

    test('creates the sample EC2 instance, RDS instance, and S3 bucket', () => {
        stackTemplate.resourceCountIs('AWS::EC2::Instance', 1);
        stackTemplate.resourceCountIs('AWS::RDS::DBInstance', 1);
        stackTemplate.resourceCountIs('AWS::S3::Bucket', 1);
    });

    test('sample EC2 instance is tagged for the backup selection', () => {
        stackTemplate.hasResourceProperties('AWS::EC2::Instance', {
            Tags: Match.arrayWith([Match.objectLike({ Key: 'Backup', Value: 'true' })]),
        });
    });

    test('sample S3 bucket is tagged for the backup selection', () => {
        stackTemplate.hasResourceProperties('AWS::S3::Bucket', {
            Tags: Match.arrayWith([Match.objectLike({ Key: 'Backup', Value: 'true' })]),
        });
    });

    test('sample RDS instance is tagged for the backup selection and encrypted', () => {
        stackTemplate.hasResourceProperties('AWS::RDS::DBInstance', {
            StorageEncrypted: true,
            Tags: Match.arrayWith([Match.objectLike({ Key: 'Backup', Value: 'true' })]),
        });
    });
});
