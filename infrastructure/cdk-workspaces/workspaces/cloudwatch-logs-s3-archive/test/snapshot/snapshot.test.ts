/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
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

const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const cdkJsonPath = path.resolve(__dirname, '../../cdk.json');
const baseContext = loadCdkContext(cdkJsonPath);

/**
 * AWS CDK Snapshot Test Suite
 *
 * Purpose:
 * 1. Detect unintended changes in the entire CloudFormation templates
 * 2. Ensure safety during refactoring
 * 3. Track changes in the number of resources
 */
describe('Stack Snapshot Tests', () => {
    describe('CloudwatchLogsS3ArchiveBasicStack', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new CloudwatchLogsS3ArchiveBasicStack(app, 'CwlArchiveBasicStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        const template = Template.fromStack(stack);
        cdk.Tags.of(app).add('Project', projectName);
        cdk.Tags.of(app).add('Environment', envName);

        test('Complete CloudFormation template snapshot', () => {
            expect(template.toJSON()).toMatchSnapshot();
        });

        test('Resource types and counts', () => {
            const templateJson = template.toJSON();
            const resourceCounts: Record<string, number> = {};
            Object.values(templateJson.Resources || {}).forEach((resource: any) => {
                const type = resource.Type;
                resourceCounts[type] = (resourceCounts[type] || 0) + 1;
            });
            expect(resourceCounts).toMatchSnapshot();
        });
    });

    describe('CloudwatchLogsS3ArchiveLifecycleStack', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new CloudwatchLogsS3ArchiveLifecycleStack(app, 'CwlArchiveLifecycleStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        const template = Template.fromStack(stack);
        cdk.Tags.of(app).add('Project', projectName);
        cdk.Tags.of(app).add('Environment', envName);

        test('Complete CloudFormation template snapshot', () => {
            expect(template.toJSON()).toMatchSnapshot();
        });

        test('Resource types and counts', () => {
            const templateJson = template.toJSON();
            const resourceCounts: Record<string, number> = {};
            Object.values(templateJson.Resources || {}).forEach((resource: any) => {
                const type = resource.Type;
                resourceCounts[type] = (resourceCounts[type] || 0) + 1;
            });
            expect(resourceCounts).toMatchSnapshot();
        });
    });

    describe('CloudwatchLogsS3ArchiveExistingStack', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new CloudwatchLogsS3ArchiveExistingStack(app, 'CwlArchiveExistingStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        const template = Template.fromStack(stack);
        cdk.Tags.of(app).add('Project', projectName);
        cdk.Tags.of(app).add('Environment', envName);

        test('Complete CloudFormation template snapshot', () => {
            expect(template.toJSON()).toMatchSnapshot();
        });

        test('Resource types and counts', () => {
            const templateJson = template.toJSON();
            const resourceCounts: Record<string, number> = {};
            Object.values(templateJson.Resources || {}).forEach((resource: any) => {
                const type = resource.Type;
                resourceCounts[type] = (resourceCounts[type] || 0) + 1;
            });
            expect(resourceCounts).toMatchSnapshot();
        });
    });

    describe('CloudwatchLogsS3ArchiveExportStack', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new CloudwatchLogsS3ArchiveExportStack(app, 'CwlArchiveExportStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        const template = Template.fromStack(stack);
        cdk.Tags.of(app).add('Project', projectName);
        cdk.Tags.of(app).add('Environment', envName);

        test('Complete CloudFormation template snapshot', () => {
            expect(template.toJSON()).toMatchSnapshot();
        });

        test('Resource types and counts', () => {
            const templateJson = template.toJSON();
            const resourceCounts: Record<string, number> = {};
            Object.values(templateJson.Resources || {}).forEach((resource: any) => {
                const type = resource.Type;
                resourceCounts[type] = (resourceCounts[type] || 0) + 1;
            });
            expect(resourceCounts).toMatchSnapshot();
        });
    });

    describe('CloudwatchLogsS3ArchiveLambdaStack', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new CloudwatchLogsS3ArchiveLambdaStack(app, 'CwlArchiveLambdaStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        const template = Template.fromStack(stack);
        cdk.Tags.of(app).add('Project', projectName);
        cdk.Tags.of(app).add('Environment', envName);

        test('Complete CloudFormation template snapshot', () => {
            expect(template.toJSON()).toMatchSnapshot();
        });

        test('Resource types and counts', () => {
            const templateJson = template.toJSON();
            const resourceCounts: Record<string, number> = {};
            Object.values(templateJson.Resources || {}).forEach((resource: any) => {
                const type = resource.Type;
                resourceCounts[type] = (resourceCounts[type] || 0) + 1;
            });
            expect(resourceCounts).toMatchSnapshot();
        });
    });
});
