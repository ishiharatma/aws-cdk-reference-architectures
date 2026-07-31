import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { BudgetsCostAnomalyDetectionBudgetStack } from 'lib/stacks/budgets-cost-anomaly-detection-budget-stack';
import { BudgetsCostAnomalyDetectionAnomalyStack } from 'lib/stacks/budgets-cost-anomaly-detection-anomaly-stack';
import { BudgetsCostAnomalyDetectionUnifiedStack } from 'lib/stacks/budgets-cost-anomaly-detection-unified-stack';
import { BudgetsCostAnomalyDetectionBillingAlarmStack } from 'lib/stacks/budgets-cost-anomaly-detection-billing-alarm-stack';
import { BudgetsCostAnomalyDetectionCostDigestStack } from 'lib/stacks/budgets-cost-anomaly-detection-cost-digest-stack';
import { params } from 'parameters/environments';
import 'test/parameters';
import * as path from 'path';
import { loadCdkContext } from '@common/test-helpers/test-context';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const cdkJsonPath = path.resolve(__dirname, '../../cdk.json');
const baseContext = loadCdkContext(cdkJsonPath);

// ============================================================================
// Stack 1: Budget alerts
// ============================================================================
describe('BudgetsCostAnomalyDetectionBudgetStack Fine-grained Assertions', () => {
    let template: Template;

    beforeAll(() => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionBudgetStack(app, 'BudgetStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        template = Template.fromStack(stack);
    });

    test('should create an SNS topic with SSL enforced', () => {
        template.hasResourceProperties('AWS::SNS::Topic', {
            TopicName: `${projectName}-${envName}-budget-alerts`,
        });
        template.hasResourceProperties('AWS::SNS::TopicPolicy', {
            PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                    Match.objectLike({ Sid: 'AllowBudgetsToPublish', Effect: 'Allow' }),
                ]),
            }),
        });
    });

    test('should create two cost budgets (account-wide and service-filtered)', () => {
        template.resourceCountIs('AWS::Budgets::Budget', 2);
    });

    test('should notify at FORECASTED 100%, ACTUAL 80% and ACTUAL 100%', () => {
        template.hasResourceProperties('AWS::Budgets::Budget', {
            NotificationsWithSubscribers: Match.arrayWith([
                Match.objectLike({
                    Notification: Match.objectLike({ NotificationType: 'FORECASTED', Threshold: 100 }),
                }),
                Match.objectLike({
                    Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 80 }),
                }),
                Match.objectLike({
                    Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 100 }),
                }),
            ]),
        });
    });

    test('should scope the second budget with a Service cost filter', () => {
        template.hasResourceProperties('AWS::Budgets::Budget', {
            Budget: Match.objectLike({
                CostFilters: { Service: ['Amazon Elastic Compute Cloud - Compute'] },
            }),
        });
    });
});

// ============================================================================
// Stack 2: Cost Anomaly Detection
// ============================================================================
describe('BudgetsCostAnomalyDetectionAnomalyStack Fine-grained Assertions', () => {
    let template: Template;

    beforeAll(() => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionAnomalyStack(app, 'AnomalyStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        template = Template.fromStack(stack);
    });

    test('should create a dimensional anomaly monitor on SERVICE', () => {
        template.hasResourceProperties('AWS::CE::AnomalyMonitor', {
            MonitorType: 'DIMENSIONAL',
            MonitorDimension: 'SERVICE',
        });
    });

    test('should create an IMMEDIATE anomaly subscription with an SNS subscriber', () => {
        template.hasResourceProperties('AWS::CE::AnomalySubscription', {
            Frequency: 'IMMEDIATE',
            Subscribers: Match.arrayWith([Match.objectLike({ Type: 'SNS' })]),
        });
    });

    test('should grant costalerts.amazonaws.com publish access to the topic', () => {
        template.hasResourceProperties('AWS::SNS::TopicPolicy', {
            PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                    Match.objectLike({ Sid: 'AllowCostAnomalyDetectionToPublish', Effect: 'Allow' }),
                ]),
            }),
        });
    });

    test('should use the base anomaly thresholds, not the unified escalation tier', () => {
        template.hasResourceProperties('AWS::CE::AnomalySubscription', {
            ThresholdExpression: Match.stringLikeRegexp(
                '.*ANOMALY_TOTAL_IMPACT_PERCENTAGE.*"20".*ANOMALY_TOTAL_IMPACT_ABSOLUTE.*"5".*',
            ),
        });
    });
});

// ============================================================================
// Stack 3: Unified alerting with optional Slack delivery
// ============================================================================
describe('BudgetsCostAnomalyDetectionUnifiedStack Fine-grained Assertions', () => {
    let template: Template;

    const fakeAnomalyMonitorArn = 'arn:aws:ce::123456789012:anomalymonitor/test-monitor-id';

    beforeAll(() => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionUnifiedStack(app, 'UnifiedStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
            anomalyMonitorArn: fakeAnomalyMonitorArn,
        });
        template = Template.fromStack(stack);
    });

    test('should create exactly one shared SNS topic for both signals', () => {
        template.resourceCountIs('AWS::SNS::Topic', 1);
    });

    test('should grant both budgets.amazonaws.com and costalerts.amazonaws.com publish access', () => {
        template.hasResourceProperties('AWS::SNS::TopicPolicy', {
            PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                    Match.objectLike({ Sid: 'AllowBudgetsToPublish', Effect: 'Allow' }),
                    Match.objectLike({ Sid: 'AllowCostAnomalyDetectionToPublish', Effect: 'Allow' }),
                ]),
            }),
        });
    });

    test('should create one budget and one anomaly subscription attached to the shared monitor (no new monitor)', () => {
        template.resourceCountIs('AWS::Budgets::Budget', 1);
        template.resourceCountIs('AWS::CE::AnomalyMonitor', 0);
        template.hasResourceProperties('AWS::CE::AnomalySubscription', {
            MonitorArnList: [fakeAnomalyMonitorArn],
        });
    });

    test("should use the stricter unifiedEscalation thresholds, not Stack 2's base thresholds", () => {
        template.hasResourceProperties('AWS::CE::AnomalySubscription', {
            ThresholdExpression: Match.stringLikeRegexp(
                '.*ANOMALY_TOTAL_IMPACT_PERCENTAGE.*"50".*ANOMALY_TOTAL_IMPACT_ABSOLUTE.*"20".*',
            ),
        });
    });

    test('should fall back to the base anomaly thresholds when unifiedEscalation is not configured', () => {
        const app = new cdk.App({ context: baseContext });
        const { unifiedEscalation: _unifiedEscalation, ...anomalyDetectionWithoutEscalation } =
            envParams.anomalyDetection;
        const stack = new BudgetsCostAnomalyDetectionUnifiedStack(app, 'UnifiedStackNoEscalation', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            anomalyMonitorArn: fakeAnomalyMonitorArn,
            params: { ...envParams, anomalyDetection: anomalyDetectionWithoutEscalation },
        });
        const fallbackTemplate = Template.fromStack(stack);
        fallbackTemplate.hasResourceProperties('AWS::CE::AnomalySubscription', {
            ThresholdExpression: Match.stringLikeRegexp(
                '.*ANOMALY_TOTAL_IMPACT_PERCENTAGE.*"20".*ANOMALY_TOTAL_IMPACT_ABSOLUTE.*"5".*',
            ),
        });
    });

    test('should not create a Slack channel configuration when slack params are omitted', () => {
        template.resourceCountIs('AWS::Chatbot::SlackChannelConfiguration', 0);
    });

    test('should create a Slack channel configuration with a ReadOnlyAccess guardrail (not AdministratorAccess) when slack params are provided', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionUnifiedStack(app, 'UnifiedStackWithSlack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            anomalyMonitorArn: fakeAnomalyMonitorArn,
            params: {
                ...envParams,
                notification: {
                    ...envParams.notification,
                    slack: { workspaceId: 'T0000000', channelId: 'C0000000' },
                },
            },
        });
        const slackTemplate = Template.fromStack(stack);
        slackTemplate.hasResourceProperties('AWS::Chatbot::SlackChannelConfiguration', {
            SlackWorkspaceId: 'T0000000',
            SlackChannelId: 'C0000000',
            GuardrailPolicies: Match.arrayWith([Match.objectLike({ 'Fn::Join': Match.anyValue() })]),
        });

        // The guardrail must be an explicit, minimal policy — not an empty array
        // (which CDK synth drops, silently reinstating AWS Chatbot's
        // AdministratorAccess default) and not AdministratorAccess itself.
        const serialized = JSON.stringify(slackTemplate.toJSON());
        expect(serialized).toContain('ReadOnlyAccess');
        expect(serialized).not.toContain('AdministratorAccess');
    });
});

// ============================================================================
// Stack 4: Classic CloudWatch billing alarm
// ============================================================================
describe('BudgetsCostAnomalyDetectionBillingAlarmStack Fine-grained Assertions', () => {
    let template: Template;

    beforeAll(() => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionBillingAlarmStack(app, 'BillingAlarmStack', {
            project: projectName,
            environment: envName,
            env: { ...defaultEnv, region: 'us-east-1' },
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        template = Template.fromStack(stack);
    });

    test('should alarm on the AWS/Billing EstimatedCharges metric in USD', () => {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            Namespace: 'AWS/Billing',
            MetricName: 'EstimatedCharges',
            Dimensions: Match.arrayWith([Match.objectLike({ Name: 'Currency', Value: 'USD' })]),
            ComparisonOperator: 'GreaterThanThreshold',
            Threshold: envParams.billingAlarm.thresholdUsd,
        });
    });

    test('should grant cloudwatch.amazonaws.com publish access to the topic', () => {
        template.hasResourceProperties('AWS::SNS::TopicPolicy', {
            PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Effect: 'Allow',
                        Principal: Match.objectLike({ Service: 'cloudwatch.amazonaws.com' }),
                        Action: 'sns:Publish',
                    }),
                ]),
            }),
        });
    });
});

// ============================================================================
// Stack 5: Scheduled cost digest to Slack/Teams
// ============================================================================
describe('BudgetsCostAnomalyDetectionCostDigestStack Fine-grained Assertions', () => {
    let template: Template;

    beforeAll(() => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionCostDigestStack(app, 'CostDigestStack', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        template = Template.fromStack(stack);
    });

    test('should build a JSONata state machine with a GetCostAndUsage → PublishCostDigest chain', () => {
        template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
            TracingConfiguration: { Enabled: true },
        });
        const templateJson = template.toJSON();
        const stateMachine = Object.values(templateJson.Resources).find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (r: any) => r.Type === 'AWS::StepFunctions::StateMachine',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any;
        const definition = JSON.stringify(stateMachine.Properties.DefinitionString);
        expect(definition).toContain('aws-sdk:costexplorer:getCostAndUsage');
        expect(definition).toContain('arn:aws:states:::sns:publish');
        expect(definition).toContain('QueryLanguage');
        expect(definition).toContain('JSONata');
    });

    test('should default to an English digest message', () => {
        const templateJson = template.toJSON();
        const stateMachine = Object.values(templateJson.Resources).find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (r: any) => r.Type === 'AWS::StepFunctions::StateMachine',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any;
        const definition = JSON.stringify(stateMachine.Properties.DefinitionString);
        expect(definition).toContain('Costs are spiking');
        expect(definition).toContain('Costs are steady');
        expect(definition).not.toContain('コストが跳ね上がっています');
    });

    test('should build a Japanese digest message when locale is set to ja', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionCostDigestStack(app, 'CostDigestStackJa', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: { ...envParams, costDigest: { ...envParams.costDigest, locale: 'ja' } },
        });
        const jaTemplate = Template.fromStack(stack);
        const templateJson = jaTemplate.toJSON();
        const stateMachine = Object.values(templateJson.Resources).find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (r: any) => r.Type === 'AWS::StepFunctions::StateMachine',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any;
        const definition = JSON.stringify(stateMachine.Properties.DefinitionString);
        expect(definition).toContain('コストが跳ね上がっています');
        expect(definition).toContain('コストは落ち着いています');
        expect(definition).not.toContain('Costs are spiking');
    });

    test('should grant the state machine role ce:GetCostAndUsage and sns:Publish', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                    Match.objectLike({ Effect: 'Allow', Action: 'ce:GetCostAndUsage', Resource: '*' }),
                ]),
            }),
        });
    });

    test('should schedule the state machine via EventBridge Scheduler', () => {
        template.hasResourceProperties('AWS::Scheduler::Schedule', {
            ScheduleExpression: envParams.costDigest.scheduleExpression,
        });
    });

    test('should not create Slack or Teams chatbot configs when notification targets are omitted', () => {
        template.resourceCountIs('AWS::Chatbot::SlackChannelConfiguration', 0);
        template.resourceCountIs('AWS::Chatbot::MicrosoftTeamsChannelConfiguration', 0);
    });

    test('should create a Microsoft Teams channel config with a ReadOnlyAccess guardrail when teams params are provided', () => {
        const app = new cdk.App({ context: baseContext });
        const stack = new BudgetsCostAnomalyDetectionCostDigestStack(app, 'CostDigestStackWithTeams', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: {
                ...envParams,
                notification: {
                    ...envParams.notification,
                    teams: {
                        teamId: '00000000-0000-0000-0000-000000000000',
                        tenantId: '00000000-0000-0000-0000-000000000000',
                        channelId: '19%3aabc%40thread.tacv2',
                    },
                },
            },
        });
        const teamsTemplate = Template.fromStack(stack);
        teamsTemplate.hasResourceProperties('AWS::Chatbot::MicrosoftTeamsChannelConfiguration', {
            TeamId: '00000000-0000-0000-0000-000000000000',
            TeamsTenantId: '00000000-0000-0000-0000-000000000000',
            TeamsChannelId: '19%3aabc%40thread.tacv2',
        });
        const serialized = JSON.stringify(teamsTemplate.toJSON());
        expect(serialized).toContain('ReadOnlyAccess');
        expect(serialized).not.toContain('AdministratorAccess');
    });
});
