/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { EcrCrrTokyoStack } from 'lib/stacks/ecr-crr-tokyo-stack';
import { EcrCrrOsakaStack } from 'lib/stacks/ecr-crr-osaka-stack';
import { params } from 'parameters/environments';
import '../parameters';

const tokyoEnv = { account: '123456789012', region: 'ap-northeast-1' };
const osakaEnv = { account: '123456789012', region: 'ap-northeast-3' };

// ECR repository names must be lowercase — keep this in sync with the unit test project name.
const projectName = 'testproject';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

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
describe('EcrCrrTokyoStack Snapshot', () => {
    const app = new cdk.App();
    const stack = new EcrCrrTokyoStack(app, 'EcrCrrTokyo', {
        project: projectName,
        environment: envName,
        env: tokyoEnv,
        params: envParams,
    });
    const stackTemplate = Template.fromStack(stack);

    test('Complete CloudFormation template snapshot', () => {
        expect(stackTemplate.toJSON()).toMatchSnapshot();
    });

    test('Resource types and counts', () => {
        const templateJson = stackTemplate.toJSON();
        const resourceCounts: Record<string, number> = {};
        Object.values(templateJson.Resources || {}).forEach((resource: any) => {
            resourceCounts[resource.Type] = (resourceCounts[resource.Type] || 0) + 1;
        });
        expect(resourceCounts).toMatchSnapshot();
    });
});

describe('EcrCrrOsakaStack Snapshot', () => {
    const app = new cdk.App();
    const stack = new EcrCrrOsakaStack(app, 'EcrCrrOsaka', {
        project: projectName,
        environment: envName,
        env: osakaEnv,
        params: envParams,
    });
    const stackTemplate = Template.fromStack(stack);

    test('Complete CloudFormation template snapshot', () => {
        expect(stackTemplate.toJSON()).toMatchSnapshot();
    });

    test('Resource types and counts', () => {
        const templateJson = stackTemplate.toJSON();
        const resourceCounts: Record<string, number> = {};
        Object.values(templateJson.Resources || {}).forEach((resource: any) => {
            resourceCounts[resource.Type] = (resourceCounts[resource.Type] || 0) + 1;
        });
        expect(resourceCounts).toMatchSnapshot();
    });
});
