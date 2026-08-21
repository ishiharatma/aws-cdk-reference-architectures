import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { AwsBackupCrrOsakaStack } from 'lib/stacks/aws-backup-crr-osaka-stack';
import { params } from 'parameters/environments';
import '../parameters';

const osakaEnv = { account: '123456789012', region: 'ap-northeast-3' };
const projectName = 'testproject';
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const vaultName = `${projectName}-${envName}-backup-osaka`;

/**
 * AwsBackupCrrOsakaStack Fine-grained Assertions
 */
describe('AwsBackupCrrOsakaStack', () => {
    let stackTemplate: Template;

    beforeAll(() => {
        const app = new cdk.App();
        const stack = new AwsBackupCrrOsakaStack(app, 'AwsBackupCrrOsaka', {
            project: projectName,
            environment: envName,
            env: osakaEnv,
            params: envParams,
            vaultName,
        });
        stackTemplate = Template.fromStack(stack);
    });

    test('creates exactly one backup vault', () => {
        stackTemplate.resourceCountIs('AWS::Backup::BackupVault', 1);
    });

    test('vault uses the deterministic shared name targeted by the Tokyo stack', () => {
        stackTemplate.hasResourceProperties('AWS::Backup::BackupVault', {
            BackupVaultName: vaultName,
        });
    });

    test('creates exactly one dedicated, rotating KMS key', () => {
        stackTemplate.resourceCountIs('AWS::KMS::Key', 1);
        stackTemplate.hasResourceProperties('AWS::KMS::Key', {
            EnableKeyRotation: true,
        });
    });

    test('exposes the vault ARN as a stack output', () => {
        stackTemplate.hasOutput('VaultArnOutput', {});
    });

    test('does not create a vault access (resource) policy — same-account copy needs none', () => {
        stackTemplate.resourceCountIs('AWS::Backup::BackupVaultPolicy', 0);
    });
});
