import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { SampleAppStack } from 'lib/stacks/sample-app-stack';
import { params } from 'parameters/environments';
import '../parameters';

const tokyoEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'testproject';
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

/**
 * SampleAppStack Fine-grained Assertions
 */
describe('SampleAppStack', () => {
    let stack: SampleAppStack;
    let stackTemplate: Template;

    beforeAll(() => {
        const app = new cdk.App();
        stack = new SampleAppStack(app, 'SampleApp', {
            project: projectName,
            environment: envName,
            env: tokyoEnv,
            params: envParams,
            isAutoDeleteObject: true,
        });
        stackTemplate = Template.fromStack(stack);
    });

    test('creates exactly one S3 bucket and one SSM parameter', () => {
        stackTemplate.resourceCountIs('AWS::S3::Bucket', 1);
        stackTemplate.resourceCountIs('AWS::SSM::Parameter', 1);
    });

    test('creates no EC2, RDS, or Backup resources of its own', () => {
        stackTemplate.resourceCountIs('AWS::EC2::Instance', 0);
        stackTemplate.resourceCountIs('AWS::RDS::DBInstance', 0);
        stackTemplate.resourceCountIs('AWS::Backup::BackupVault', 0);
    });

    test('the stack itself is tagged for the tag-based Backup Selection', () => {
        expect(stack.tags.tagValues()).toMatchObject({ Backup: 'true' });
    });
});
