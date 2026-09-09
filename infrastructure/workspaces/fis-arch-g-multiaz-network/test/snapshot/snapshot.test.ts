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

const projectName = 'fis-chaos-g';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName]!;

/**
 * Snapshot tests for FIS chaos scenario G stacks.
 * Run `npm run test:snapshot:update` when intentional changes are made.
 */
describe('FIS Chaos Scenario G Stack Snapshots', () => {
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
    });

    const fisStack = new FisStack(app, 'TestFisStack', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        terminationProtection: false,
        targetGroup: appStack.targetGroup,
        auroraCluster: baseStack.auroraCluster,
        azSubnetArns: baseStack.azSubnetArns,
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

        test('VPC spans 2 Availability Zones (2 private-with-egress subnets)', () => {
            expect(baseStack.appSubnets).toHaveLength(2);
            expect(baseStack.azSubnetArns).toHaveLength(2);
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

        test('NLB exists and is internet-facing', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
                Type: 'network',
                Scheme: 'internet-facing',
            });
        });

        test('Target group is TCP on port 80', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                Protocol: 'TCP',
                Port: 80,
            });
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

        test('G-1 and G-2 use aws:network:disrupt-connectivity targeting aws:ec2:subnet', () => {
            const templates = template.findResources('AWS::FIS::ExperimentTemplate');
            const disruptTemplates = Object.values(templates).filter((t: any) =>
                Object.values(t.Properties.Actions).some(
                    (a: any) => a.ActionId === 'aws:network:disrupt-connectivity',
                ),
            );
            expect(disruptTemplates).toHaveLength(2);
            disruptTemplates.forEach((t: any) => {
                const targets: any = Object.values(t.Properties.Targets)[0];
                expect(targets.ResourceType).toBe('aws:ec2:subnet');
            });
        });
    });
});
