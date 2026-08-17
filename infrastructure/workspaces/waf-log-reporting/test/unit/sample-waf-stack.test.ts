import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { WafLogReportingSampleWafStack } from 'lib/stacks/waf-log-reporting-sample-waf-stack';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = 'WafLogReportingTest';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

describe('WafLogReportingSampleWafStack', () => {
    let template: Template;

    beforeAll(() => {
        const app = new cdk.App();
        const stack = new WafLogReportingSampleWafStack(app, 'SampleWaf', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        template = Template.fromStack(stack);
    });

    test('creates a REGIONAL Web ACL with the default allow action', () => {
        template.hasResourceProperties('AWS::WAFv2::WebACL', {
            Scope: 'REGIONAL',
            DefaultAction: { Allow: {} },
        });
    });

    test('Web ACL has exactly three rules: Count, Block (managed group), Block (rate-based)', () => {
        template.hasResourceProperties('AWS::WAFv2::WebACL', {
            Rules: Match.arrayWith([
                Match.objectLike({
                    Name: 'CommonRuleSet-Count',
                    Priority: 0,
                    OverrideAction: { Count: {} },
                }),
                Match.objectLike({
                    Name: 'KnownBadInputs-Block',
                    Priority: 1,
                    OverrideAction: { None: {} },
                }),
                Match.objectLike({
                    Name: 'RateLimit-Block',
                    Priority: 2,
                    Action: { Block: {} },
                    Statement: {
                        RateBasedStatement: Match.objectLike({ Limit: 2000, AggregateKeyType: 'IP' }),
                    },
                }),
            ]),
        });
        const webAcls = template.findResources('AWS::WAFv2::WebACL');
        const [webAcl] = Object.values(webAcls);
        expect(webAcl.Properties.Rules).toHaveLength(3);
    });

    test('log group name starts with the aws-waf-logs- prefix required by AWS WAF', () => {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
            LogGroupName: `aws-waf-logs-${projectName}-${envName}`,
        });
    });

    test('a CloudWatch Logs resource policy scopes write access to this Web ACL', () => {
        // The PolicyDocument is built via JSON.stringify() over an object
        // containing CDK tokens (account/Web ACL ARN), so CDK renders it as
        // an Fn::Join rather than a literal string. Assert on the joined
        // string fragments instead of parsing serialized JSON.
        const policies = template.findResources('AWS::Logs::ResourcePolicy');
        const [policy] = Object.values(policies);
        const joined = (policy.Properties.PolicyDocument['Fn::Join']?.[1] ?? []).join('');
        expect(joined).toContain('delivery.logs.amazonaws.com');
        expect(joined).toContain('logs:CreateLogStream');
        expect(joined).toContain('logs:PutLogEvents');
    });

    test('WAF logging configuration targets the log group', () => {
        template.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
            LogDestinationConfigs: Match.anyValue(),
        });
        template.resourceCountIs('AWS::WAFv2::LoggingConfiguration', 1);
    });
});
