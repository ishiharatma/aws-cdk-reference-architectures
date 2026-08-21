/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { AwsBackupCrrOsakaStack } from 'lib/stacks/aws-backup-crr-osaka-stack';
import { AwsBackupCrrTokyoStack } from 'lib/stacks/aws-backup-crr-tokyo-stack';
import { SampleAppStack } from 'lib/stacks/sample-app-stack';
import { params } from 'parameters/environments';
import '../parameters';

const tokyoEnv = { account: '123456789012', region: 'ap-northeast-1' };
const osakaEnv = { account: '123456789012', region: 'ap-northeast-3' };

const projectName = 'testproject';
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const destinationVaultName = `${projectName}-${envName}-backup-osaka`;

/**
 * AWS CDK Snapshot Test Suite
 *
 * Purpose of this test suite:
 * 1. Detect unintended changes in the entire CloudFormation template
 * 2. Ensure safety during refactoring
 * 3. Track changes in the number of resources
 *
 * Note: Detailed configuration value verification is done with unit tests (test/unit/)
 */
function resourceCounts(template: Template): Record<string, number> {
    const resourceCounts: Record<string, number> = {};
    Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
        resourceCounts[resource.Type] = (resourceCounts[resource.Type] || 0) + 1;
    });
    return resourceCounts;
}

describe('AwsBackupCrrOsakaStack Snapshot', () => {
    const app = new cdk.App();
    const stack = new AwsBackupCrrOsakaStack(app, 'AwsBackupCrrOsaka', {
        project: projectName,
        environment: envName,
        env: osakaEnv,
        params: envParams,
        vaultName: destinationVaultName,
    });
    const stackTemplate = Template.fromStack(stack);

    test('Complete CloudFormation template snapshot', () => {
        expect(stackTemplate.toJSON()).toMatchSnapshot();
    });

    test('Resource types and counts', () => {
        expect(resourceCounts(stackTemplate)).toMatchSnapshot();
    });
});

describe('SampleAppStack Snapshot', () => {
    const app = new cdk.App();
    const stack = new SampleAppStack(app, 'AwsBackupSampleApp', {
        project: projectName,
        environment: envName,
        env: tokyoEnv,
        params: envParams,
        isAutoDeleteObject: true,
    });
    const stackTemplate = Template.fromStack(stack);

    test('Complete CloudFormation template snapshot', () => {
        expect(stackTemplate.toJSON()).toMatchSnapshot();
    });

    test('Resource types and counts', () => {
        expect(resourceCounts(stackTemplate)).toMatchSnapshot();
    });
});

describe('AwsBackupCrrTokyoStack Snapshot', () => {
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
    const stackTemplate = Template.fromStack(stack);

    // Cleanup after the entire test suite
    afterAll(() => {
        app.node.children.forEach((child) => {
            if (child instanceof cdk.Stack) {
                child.node.tryRemoveChild('ResourceHandlerCustomResourceProvider');
            }
        });
    });

    test('Complete CloudFormation template snapshot', () => {
        expect(stackTemplate.toJSON()).toMatchSnapshot();
    });

    test('Resource types and counts', () => {
        expect(resourceCounts(stackTemplate)).toMatchSnapshot();
    });
});
