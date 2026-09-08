/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { params } from 'parameters/environments';
import '../parameters';

import { BaseStack } from 'lib/stacks/base-stack';
import { AppStack } from 'lib/stacks/app-stack';
import { FisStack } from 'lib/stacks/fis-stack';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = 'fis-chaos-b';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName]!;

/**
 * Snapshot tests for FIS chaos scenario B stacks.
 * Run `npm run test:snapshot:update` when intentional changes are made.
 */
describe('FIS Chaos Scenario B Stack Snapshots', () => {
    const app = new cdk.App();

    const baseStack = new BaseStack(app, 'TestBaseStack', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
    });

    const appStack = new AppStack(app, 'TestAppStack', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
        table: baseStack.table,
    });

    const fisStack = new FisStack(app, 'TestFisStack', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        terminationProtection: false,
        apiFunction: appStack.apiFunction,
        table: baseStack.table,
        alarmEmail: envParams.alarmEmail,
    });

    cdk.Tags.of(app).add('Project', projectName);
    cdk.Tags.of(app).add('Environment', envName);

    afterAll(() => {
        app.node.children.forEach((child) => {
            if (child instanceof cdk.Stack) {
                child.node.tryRemoveChild('ResourceHandlerCustomResourceProvider');
            }
        });
    });

    describe('BaseStack', () => {
        const template = Template.fromStack(baseStack);

        test('Complete CloudFormation template snapshot', () => {
            expect(template.toJSON()).toMatchSnapshot();
        });

        test('Resource types and counts', () => {
            const resourceCounts: Record<string, number> = {};
            Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
                const type = resource.Type;
                resourceCounts[type] = (resourceCounts[type] || 0) + 1;
            });
            expect(resourceCounts).toMatchSnapshot();
        });

        test('DynamoDB table exists with PAY_PER_REQUEST billing', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                BillingMode: 'PAY_PER_REQUEST',
            });
        });
    });

    describe('AppStack', () => {
        const template = Template.fromStack(appStack);

        test('Complete CloudFormation template snapshot', () => {
            expect(template.toJSON()).toMatchSnapshot();
        });

        test('Resource types and counts', () => {
            const resourceCounts: Record<string, number> = {};
            Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
                const type = resource.Type;
                resourceCounts[type] = (resourceCounts[type] || 0) + 1;
            });
            expect(resourceCounts).toMatchSnapshot();
        });

        test('Lambda function uses Python 3.13 runtime', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Runtime: 'python3.13',
            });
        });

        test('CloudFront distribution exists', () => {
            template.resourceCountIs('AWS::CloudFront::Distribution', 1);
        });

        test('API Gateway HTTP API exists', () => {
            template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
        });
    });

    describe('FisStack', () => {
        const template = Template.fromStack(fisStack);

        test('Complete CloudFormation template snapshot', () => {
            expect(template.toJSON()).toMatchSnapshot();
        });

        test('Resource types and counts', () => {
            const resourceCounts: Record<string, number> = {};
            Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
                const type = resource.Type;
                resourceCounts[type] = (resourceCounts[type] || 0) + 1;
            });
            expect(resourceCounts).toMatchSnapshot();
        });

        test('Exactly 4 FIS experiment templates are created', () => {
            template.resourceCountIs('AWS::FIS::ExperimentTemplate', 4);
        });

        test('All FIS templates have stop conditions', () => {
            const templates = template.findResources('AWS::FIS::ExperimentTemplate');
            Object.values(templates).forEach((t: any) => {
                const stopConditions = t.Properties.StopConditions;
                expect(stopConditions).toBeDefined();
                expect(stopConditions.length).toBeGreaterThan(0);
                expect(stopConditions[0].Source).toBe('aws:cloudwatch:alarm');
            });
        });
    });
});
