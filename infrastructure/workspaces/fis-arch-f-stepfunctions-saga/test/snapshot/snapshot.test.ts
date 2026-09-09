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

const projectName = 'fis-chaos-f';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName]!;

/**
 * Snapshot tests for FIS chaos scenario F stacks.
 * Run `npm run test:snapshot:update` when intentional changes are made.
 */
describe('FIS Chaos Scenario F Stack Snapshots', () => {
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
        reserveInventoryFn: appStack.reserveInventoryFn,
        processPaymentFn: appStack.processPaymentFn,
        confirmOrderFn: appStack.confirmOrderFn,
        stateMachine: appStack.stateMachine,
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

        test('Exactly 5 Lambda functions with Python 3.13 runtime', () => {
            template.resourceCountIs('AWS::Lambda::Function', 5);
            template.hasResourceProperties('AWS::Lambda::Function', {
                Runtime: 'python3.13',
            });
        });

        test('Exactly 1 Standard Step Functions state machine', () => {
            template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
            template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                StateMachineType: 'STANDARD',
                TracingConfiguration: { Enabled: true },
            });
        });

        test('State machine definition contains all 5 Saga task states', () => {
            const resources = template.findResources('AWS::StepFunctions::StateMachine');
            const stateMachine = Object.values(resources)[0] as any;
            const definitionString = JSON.stringify(
                stateMachine.Properties.DefinitionString,
            );
            ['ReserveInventory', 'ProcessPayment', 'ConfirmOrder'].forEach((state) => {
                expect(definitionString).toContain(state);
            });
            expect(definitionString).toContain('ReleaseInventoryCompensation');
            expect(definitionString).toContain('RefundPaymentCompensation1');
            expect(definitionString).toContain('ReleaseInventoryCompensation2');
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

        test('Exactly 3 FIS experiment templates are created', () => {
            template.resourceCountIs('AWS::FIS::ExperimentTemplate', 3);
        });

        test('All FIS templates use the Lambda concurrency action only', () => {
            const templates = template.findResources('AWS::FIS::ExperimentTemplate');
            Object.values(templates).forEach((t: any) => {
                const actions = t.Properties.Actions;
                Object.values(actions).forEach((action: any) => {
                    expect(action.ActionId).toBe('aws:lambda:put-function-concurrent-executions');
                });
            });
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
