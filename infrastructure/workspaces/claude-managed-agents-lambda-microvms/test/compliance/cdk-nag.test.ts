import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { ClaudeManagedAgentsLambdaMicrovmsStack } from 'lib/stacks/claude-managed-agents-lambda-microvms-stack';
import { buildStack } from '../helpers';
import '../parameters';

const suppress = (stack: ClaudeManagedAgentsLambdaMicrovmsStack) => {
  NagSuppressions.addStackSuppressions(stack, [
    { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole are the AWS-recommended policies for Lambda logging and connector ENI management.' },
    { id: 'AwsSolutions-IAM5', reason: 'MicroVM and network connector IDs are assigned at run time (lambda:RunMicrovm, TerminateMicrovm, ListMicrovms, PassNetworkConnector), and PutMetricData has no resource-level permissions (bounded by the cloudwatch:namespace condition).' },
    { id: 'AwsSolutions-APIG2', reason: 'Request validation is enabled on the webhook method.' },
    { id: 'AwsSolutions-APIG4', reason: 'The sender is authenticated by the HMAC signature of the raw body in the launcher; an authorizer never receives the body.' },
    { id: 'AwsSolutions-APIG6', reason: 'Execution logging needs the account-level API Gateway CloudWatch role, which this repository disables. Access logs, X-Ray tracing and WAF logs are enabled instead.' },
    { id: 'AwsSolutions-COG4', reason: 'No Cognito user pool: the webhook is authenticated by its HMAC signature.' },
    { id: 'AwsSolutions-VPC7', reason: 'Reference pattern: firewall flow and alert logs already record every connection of this VPC.' },
    { id: 'AwsSolutions-L1', reason: 'NodejsFunction is pinned to Node.js 22, the latest runtime the bundler targets in this repository.' },
    { id: 'AwsSolutions-S1', reason: 'The CDK asset bucket is managed by the bootstrap stack.' },
  ], true);
};

describe.each([
  ['internet egress', {}],
  ['firewall egress', { network: { egressMode: 'firewall' as const, ingressMode: 'none' as const, allowedDomains: ['api.anthropic.com', '.amazonaws.com'] } }],
])('CDK Nag AwsSolutions Pack (%s)', (_name, overrides) => {
  let stack: ClaudeManagedAgentsLambdaMicrovmsStack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = buildStack(overrides, app);
    suppress(stack);
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  });

  test('No unsuppressed Warnings', () => {
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    if (warnings.length > 0) console.log(JSON.stringify(warnings.map((w) => [w.id, w.entry.data]), null, 2));
    expect(warnings).toHaveLength(0);
  });

  test('No unsuppressed Errors', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    if (errors.length > 0) console.log(JSON.stringify(errors.map((e) => [e.id, e.entry.data]), null, 2));
    expect(errors).toHaveLength(0);
  });
});
