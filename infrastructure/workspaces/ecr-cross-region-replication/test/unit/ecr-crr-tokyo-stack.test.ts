/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EcrCrrTokyoStack } from 'lib/stacks/ecr-crr-tokyo-stack';
import { Environment } from '@common/parameters/environments';
import { params, EnvParams } from 'parameters/environments';
import '../parameters';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = 'testproject';
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

/**
 * EcrCrrTokyoStack Fine-grained Assertions
 */
describe('EcrCrrTokyoStack', () => {
    let stackTemplate: Template;

    beforeAll(() => {
        const app = new cdk.App();
        const stack = new EcrCrrTokyoStack(app, 'EcrCrrTokyo', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            params: envParams,
        });
        stackTemplate = Template.fromStack(stack);
    });

    test('creates exactly one source ECR repository', () => {
        stackTemplate.resourceCountIs('AWS::ECR::Repository', 1);
    });

    test('source repository uses the shared deterministic name', () => {
        stackTemplate.hasResourceProperties('AWS::ECR::Repository', {
            RepositoryName: `${projectName}-${envName}-sample-app`,
        });
    });

    test('creates exactly one registry replication configuration', () => {
        stackTemplate.resourceCountIs('AWS::ECR::ReplicationConfiguration', 1);
    });

    test('replication configuration targets the destination region with a name-matching filter', () => {
        stackTemplate.hasResourceProperties('AWS::ECR::ReplicationConfiguration', {
            ReplicationConfiguration: {
                Rules: [
                    {
                        Destinations: [
                            {
                                Region: 'ap-northeast-3',
                                RegistryId: defaultEnv.account,
                            },
                        ],
                        RepositoryFilters: [
                            {
                                Filter: `${projectName}-${envName}-sample-app`,
                                FilterType: 'PREFIX_MATCH',
                            },
                        ],
                    },
                ],
            },
        });
    });

    test('replication configuration depends on the source repository', () => {
        const template = stackTemplate.toJSON();
        const replicationResource: any = Object.values(template.Resources).find(
            (resource: any) => resource.Type === 'AWS::ECR::ReplicationConfiguration',
        );
        expect(replicationResource.DependsOn).toBeDefined();
    });

    test('keeps image scanning unset by default (per source config isImageScanOnPush: true)', () => {
        stackTemplate.hasResourceProperties('AWS::ECR::Repository', {
            ImageScanningConfiguration: { ScanOnPush: true },
        });
    });

    test('throws when source and destination repositoryNameSuffix diverge', () => {
        const app = new cdk.App();
        const mismatchedParams: EnvParams = {
            ...envParams,
            ecrCrr: {
                ...envParams.ecrCrr,
                destinationEcrConfig: {
                    createConfig: {
                        ...envParams.ecrCrr.destinationEcrConfig?.createConfig,
                        repositoryNameSuffix: 'different-name',
                    },
                },
            },
        };

        expect(() => {
            new EcrCrrTokyoStack(app, 'EcrCrrTokyoMismatch', {
                project: projectName,
                environment: envName,
                env: defaultEnv,
                params: mismatchedParams,
            });
        }).toThrow(/repositoryNameSuffix/);
    });

    test('does not create a repository policy', () => {
        stackTemplate.resourceCountIs('AWS::ECR::RepositoryPolicy', 0);
    });
});
