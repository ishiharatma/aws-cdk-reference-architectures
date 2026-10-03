import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { makeStacks } from '../helpers/make-stacks';

const { app, baseStack, probeStack, fisStack } = makeStacks('Nag');

const demoReason =
    'Short-lived chaos-engineering reference pattern: resources are destroyed with the stack ' +
    'after the experiment window and never hold production data.';

NagSuppressions.addStackSuppressions(
    baseStack,
    [
        { id: 'AwsSolutions-VPC7', reason: 'VPC Flow Logs are out of scope. ' + demoReason },
        { id: 'AwsSolutions-RDS3', reason: 'The Multi-AZ instance is Multi-AZ; RDS3 is a false positive for the L1 cluster. ' + demoReason },
        { id: 'AwsSolutions-RDS6', reason: 'IAM database authentication is not used; credentials come from Secrets Manager.' },
        { id: 'AwsSolutions-RDS10', reason: 'Deletion protection is disabled so the stack can be torn down. ' + demoReason },
        { id: 'AwsSolutions-RDS11', reason: 'Default PostgreSQL port is kept; access is restricted by security group.' },
        { id: 'AwsSolutions-SMG4', reason: 'Automatic rotation is out of scope. ' + demoReason },
        { id: 'AwsSolutions-IAM4', reason: 'CDK-managed log-retention / VPC custom-resource roles use AWS managed policies.' },
        { id: 'AwsSolutions-IAM5', reason: 'Wildcards come from CDK-managed custom resources.' },
        { id: 'AwsSolutions-RDS2', reason: 'Storage encryption is enabled on both databases (StorageEncrypted: true).' },
    ],
    true,
);

NagSuppressions.addStackSuppressions(
    probeStack,
    [
        { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole / AWSLambdaVPCAccessExecutionRole are the accepted Lambda baselines.' },
        { id: 'AwsSolutions-IAM5', reason: 'Secret.grantRead() and the VPC ENI/log permissions generate scoped wildcards.' },
        { id: 'AwsSolutions-SNS2', reason: 'Alarm topic carries no sensitive payload. ' + demoReason },
        { id: 'AwsSolutions-SNS3', reason: 'Alarm topic carries no sensitive payload. ' + demoReason },
        { id: 'AwsSolutions-L1', reason: 'Runtime is pinned to a current Node.js LTS line.' },
    ],
    true,
);

NagSuppressions.addStackSuppressions(
    fisStack,
    [
        { id: 'AwsSolutions-IAM5', reason: 'tag:GetResources and CloudWatch Logs delivery APIs do not support resource-level permissions.' },
    ],
    true,
);

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

describe.each([
    ['BaseStack', baseStack],
    ['ProbeStack', probeStack],
    ['FisStack', fisStack],
])('cdk-nag AwsSolutions: %s', (_name, stack) => {
    test('no unsuppressed errors', () => {
        const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
        expect(errors.map((e) => `${e.id}: ${e.entry.data}`)).toEqual([]);
    });
    test('no unsuppressed warnings', () => {
        const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
        expect(warnings.map((e) => `${e.id}: ${e.entry.data}`)).toEqual([]);
    });
});
