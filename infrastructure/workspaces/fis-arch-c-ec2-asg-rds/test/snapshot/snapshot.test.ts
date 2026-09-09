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

const projectName = 'fis-chaos-c';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName]!;

/**
 * Snapshot tests for FIS chaos scenario C stacks.
 * Run `npm run test:snapshot:update` when intentional changes are made.
 */
describe('FIS Chaos Scenario C Stack Snapshots', () => {
    const app = new cdk.App();

    const baseStack = new BaseStack(app, 'TestBaseStack', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
        vpcConfig: envParams.vpcConfig,
    });

    const appStack = new AppStack(app, 'TestAppStack', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
        vpc: baseStack.vpc,
        auroraCluster: baseStack.auroraCluster,
        auroraSecret: baseStack.auroraSecret,
        cloudfrontManagedPrefixList: envParams.cloudfrontManagedPrefixList,
    });

    const fisStack = new FisStack(app, 'TestFisStack', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        terminationProtection: false,
        asg: appStack.asg,
        alb: appStack.alb,
        auroraCluster: baseStack.auroraCluster,
        alarmEmail: envParams.alarmEmail,
    });

    cdk.Tags.of(app).add('Project', projectName);
    cdk.Tags.of(app).add('Environment', envName);

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

        test('VPC exists', () => {
            template.resourceCountIs('AWS::EC2::VPC', 1);
        });

        test('Aurora cluster exists with encrypted storage', () => {
            template.hasResourceProperties('AWS::RDS::DBCluster', {
                StorageEncrypted: true,
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

        test('Auto Scaling Group exists', () => {
            template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
        });

        test('ALB exists and is not internet-facing', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
                Scheme: 'internal',
            });
        });

        test('CloudFront distribution exists', () => {
            template.resourceCountIs('AWS::CloudFront::Distribution', 1);
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
