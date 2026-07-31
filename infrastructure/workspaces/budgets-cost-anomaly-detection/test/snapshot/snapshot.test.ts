/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { BudgetsCostAnomalyDetectionBudgetStack } from 'lib/stacks/budgets-cost-anomaly-detection-budget-stack';
import { BudgetsCostAnomalyDetectionAnomalyStack } from 'lib/stacks/budgets-cost-anomaly-detection-anomaly-stack';
import { BudgetsCostAnomalyDetectionUnifiedStack } from 'lib/stacks/budgets-cost-anomaly-detection-unified-stack';
import { BudgetsCostAnomalyDetectionBillingAlarmStack } from 'lib/stacks/budgets-cost-anomaly-detection-billing-alarm-stack';
import { BudgetsCostAnomalyDetectionCostDigestStack } from 'lib/stacks/budgets-cost-anomaly-detection-cost-digest-stack';
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
    describe('BudgetsCostAnomalyDetectionBudgetStack', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionBudgetStack(app, 'BudgetStack', {
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

    describe('BudgetsCostAnomalyDetectionAnomalyStack', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionAnomalyStack(app, 'AnomalyStack', {
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

    describe('BudgetsCostAnomalyDetectionUnifiedStack', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionUnifiedStack(app, 'UnifiedStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
            anomalyMonitorArn: 'arn:aws:ce::123456789012:anomalymonitor/test-monitor-id',
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

    describe('BudgetsCostAnomalyDetectionBillingAlarmStack', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionBillingAlarmStack(app, 'BillingAlarmStack', {
            project: projectName,
            environment: envName,
            env: { ...defaultEnv, region: 'us-east-1' },
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

    describe('BudgetsCostAnomalyDetectionCostDigestStack', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionCostDigestStack(app, 'CostDigestStack', {
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
