import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { Route53PhzDelegationStack } from 'lib/stacks/route53-phz-delegation-stack';
import { EnvParams } from 'lib/types/route53-phz-delegation-params';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = {
    account: '123456789012',
    region: 'us-east-1',
};

const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

const loaded = params[envName];
if (!loaded) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams: EnvParams = loaded;

/**
 * AWS CDK Snapshot Test Suite
 *
 * Purpose:
 * 1. Detect unintended changes across the entire CloudFormation template
 * 2. Ensure safety during refactoring
 * 3. Track the number of resources (cost impact)
 *
 * Detailed value verification lives in test/unit/.
 */
describe('Stack Snapshot Tests', () => {
    const app = new cdk.App();
    cdk.Tags.of(app).add('Project', projectName);
    cdk.Tags.of(app).add('Environment', envName);

    const stack = new Route53PhzDelegationStack(app, 'Route53PhzDelegation', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
        params: envParams,
    });

    const stackTemplate = Template.fromStack(stack);

    afterAll(() => {
        app.node.children.forEach((child) => {
            if (child instanceof cdk.Stack) {
                child.node.tryRemoveChild('ResourceHandlerCustomResourceProvider');
            }
        });
    });

    describe('CloudFormation Template Snapshots', () => {
        test('Complete CloudFormation template snapshot', () => {
            expect(stackTemplate.toJSON()).toMatchSnapshot();
        });

        test('Resource types and counts', () => {
            const templateJson = stackTemplate.toJSON();
            const resourceCounts: Record<string, number> = {};

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            Object.values(templateJson.Resources || {}).forEach((resource: any) => {
                const type = resource.Type;
                resourceCounts[type] = (resourceCounts[type] || 0) + 1;
            });

            expect(resourceCounts).toMatchSnapshot();
        });
    });
});
