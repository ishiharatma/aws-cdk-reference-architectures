/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EcrCrrOsakaStack } from 'lib/stacks/ecr-crr-osaka-stack';
import { Environment } from '@common/parameters/environments';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-3',
};

const projectName = 'testproject';
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

/**
 * EcrCrrOsakaStack Fine-grained Assertions
 */
describe('EcrCrrOsakaStack', () => {
    let stackTemplate: Template;

    beforeAll(() => {
        const app = new cdk.App();
        const stack = new EcrCrrOsakaStack(app, 'EcrCrrOsaka', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            params: envParams,
        });
        stackTemplate = Template.fromStack(stack);
    });

    test('creates exactly one destination ECR repository', () => {
        stackTemplate.resourceCountIs('AWS::ECR::Repository', 1);
    });

    test('destination repository shares the same deterministic name as the source', () => {
        stackTemplate.hasResourceProperties('AWS::ECR::Repository', {
            RepositoryName: `${projectName}-${envName}-sample-app`,
        });
    });

    test('does not declare a replication configuration (only the source region does)', () => {
        stackTemplate.resourceCountIs('AWS::ECR::ReplicationConfiguration', 0);
    });

    test('destination lifecycle policy is independently configured (leaner than the source)', () => {
        const template = stackTemplate.toJSON();
        const repo: any = Object.values(template.Resources).find(
            (resource: any) => resource.Type === 'AWS::ECR::Repository',
        );
        const policyText = JSON.parse(repo.Properties.LifecyclePolicy.LifecyclePolicyText);
        const untaggedRule = policyText.rules.find((rule: any) => rule.selection.tagStatus === 'untagged');
        expect(untaggedRule.selection.countNumber).toBe(7);
    });

    test('explicitly disables image scan-on-push (per destination config isImageScanOnPush: false)', () => {
        stackTemplate.hasResourceProperties('AWS::ECR::Repository', {
            ImageScanningConfiguration: { ScanOnPush: false },
        });
    });

    test('falls back to sourceEcrConfig when destinationEcrConfig is not provided', () => {
        const app = new cdk.App();
        const fallbackParams = {
            ...envParams,
            ecrCrr: {
                sourceEcrConfig: envParams.ecrCrr.sourceEcrConfig,
                destinationRegion: envParams.ecrCrr.destinationRegion,
            },
        };
        const stack = new EcrCrrOsakaStack(app, 'EcrCrrOsakaFallback', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            params: fallbackParams,
        });
        const template = Template.fromStack(stack);
        template.hasResourceProperties('AWS::ECR::Repository', {
            RepositoryName: `${projectName}-${envName}-sample-app`,
        });
    });
});
