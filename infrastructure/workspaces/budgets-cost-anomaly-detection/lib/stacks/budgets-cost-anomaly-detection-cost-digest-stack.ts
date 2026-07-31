import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as chatbot from 'aws-cdk-lib/aws-chatbot';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as scheduler_targets from 'aws-cdk-lib/aws-scheduler-targets';
import { CostAlertTopic, SafeSlackChannelConfiguration, SafeMicrosoftTeamsChannelConfiguration } from '@common/constructs/cost';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface BudgetsCostAnomalyDetectionCostDigestStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

/**
 * JSONata expression (no `{% %}` wrapper) for the digest message title, in
 * the requested locale.
 */
function buildCostDigestTitleExpression(locale: 'ja' | 'en'): string {
    if (locale === 'en') {
        return '$states.input.CostSum > $AngryThreshold ? "😱 Costs are spiking" : "😊 Costs are steady"';
    }
    return '$states.input.CostSum > $AngryThreshold ? "😱 コストが跳ね上がっています" : "😊 コストは落ち着いています"';
}

/**
 * JSONata expression (no `{% %}` wrapper) for the digest message
 * description, in the requested locale. Built with explicit `\\n` (literal
 * backslash+n, not a real line break) so the JSONata source — after this
 * whole object round-trips through ASL/CFN JSON — still contains a JSONata
 * string-literal escape, not a raw control character.
 */
function buildCostDigestDescriptionExpression(locale: 'ja' | 'en', periodDays: number): string {
    if (locale === 'en') {
        return (
            '"AWS Account ID: " & $AccountId & " (" & $Project & "/" & $Environment & ")"' +
            ' & "\\n"' +
            ' & ( $states.input.CostSum > $AngryThreshold ? "🚨" : "✅" )' +
            ` & "Cost over the last ${periodDays} days: "` +
            ' & $string($states.input.CostSum)' +
            ' & " USD."' +
            ' & "\\n"' +
            ` & "👁‍🗨 ${periodDays}-day threshold: " & $AngryThreshold & " USD"` +
            ' & "📅 Period: " & $states.input.Start & " to " & $states.input.End' +
            ' & "\\n"' +
            ' & "💸 Top 5 services by cost"' +
            ' & "\\n"' +
            ' & "\\n:one: " & ( $states.input.CostSorted[0].Service ~> $replace(/^(AWS|Amazon)\\s*/, "") ) & ": " & $states.input.CostSorted[0].Total & " USD"' +
            ' & "\\n:two: " & ( $states.input.CostSorted[1].Service ~> $replace(/^(AWS|Amazon)\\s*/, "") ) & ": " & $states.input.CostSorted[1].Total & " USD"' +
            ' & "\\n:three: " & ( $states.input.CostSorted[2].Service ~> $replace(/^(AWS|Amazon)\\s*/, "") ) & ": " & $states.input.CostSorted[2].Total & " USD"' +
            ' & "\\n:four: " & ( $states.input.CostSorted[3].Service ~> $replace(/^(AWS|Amazon)\\s*/, "") ) & ": " & $states.input.CostSorted[3].Total & " USD"' +
            ' & "\\n:five: " & ( $states.input.CostSorted[4].Service ~> $replace(/^(AWS|Amazon)\\s*/, "") ) & ": " & $states.input.CostSorted[4].Total & " USD"' +
            ' & "\\n"' +
            ' & "* Note: cost data has a reporting lag and may not reflect the most recent charges."'
        );
    }
    return (
        '"AWSアカウントID: " & $AccountId & " (" & $Project & "/" & $Environment & ")"' +
        ' & "\\n"' +
        ' & ( $states.input.CostSum > $AngryThreshold ? "🚨" : "✅" )' +
        ` & "直近${periodDays}日間のコストは "` +
        ' & $string($states.input.CostSum)' +
        ' & " USD です。"' +
        ' & "\\n"' +
        ` & "👁‍🗨${periodDays}日あたりのコスト閾値: " & $AngryThreshold & " USD"` +
        ' & "📅集計期間: " & $states.input.Start & " ～ " & $states.input.End' +
        ' & "\\n"' +
        ' & "💸コスト使用量上位5位サービス"' +
        ' & "\\n"' +
        ' & "\\n:one: " & ( $states.input.CostSorted[0].Service ~> $replace(/^(AWS|Amazon)\\s*/, "") ) & ": " & $states.input.CostSorted[0].Total & " USD"' +
        ' & "\\n:two: " & ( $states.input.CostSorted[1].Service ~> $replace(/^(AWS|Amazon)\\s*/, "") ) & ": " & $states.input.CostSorted[1].Total & " USD"' +
        ' & "\\n:three: " & ( $states.input.CostSorted[2].Service ~> $replace(/^(AWS|Amazon)\\s*/, "") ) & ": " & $states.input.CostSorted[2].Total & " USD"' +
        ' & "\\n:four: " & ( $states.input.CostSorted[3].Service ~> $replace(/^(AWS|Amazon)\\s*/, "") ) & ": " & $states.input.CostSorted[3].Total & " USD"' +
        ' & "\\n:five: " & ( $states.input.CostSorted[4].Service ~> $replace(/^(AWS|Amazon)\\s*/, "") ) & ": " & $states.input.CostSorted[4].Total & " USD"' +
        ' & "\\n"' +
        ' & "※ コスト反映にはタイムラグがあるため、最新ではない可能性があります。"'
    );
}

/**
 * Stack 5 – Scheduled Cost Digest to Slack / Microsoft Teams
 *
 * Adapted from a hand-authored CloudFormation pattern for posting a rolling
 * cost summary to a chat channel on a schedule (a proactive "push" digest,
 * as opposed to Stacks 1/2/4's threshold-triggered "pull" alerts):
 *
 *   EventBridge Scheduler (cron)
 *     → Step Functions (JSONata, Standard)
 *         1. GetCostAndUsage  – Cost Explorer SDK integration, groups the
 *            trailing `periodDays` of spend by service and computes the
 *            top-5 breakdown + total, entirely in JSONata (no Lambda).
 *         2. PublishCostDigest – Formats a markdown message (tone driven by
 *            `angryThresholdUsd`) and publishes it to SNS.
 *     → SNS Topic → AWS Chatbot → Slack and/or Microsoft Teams (either or both,
 *       depending on which of params.notification.{slack,teams} are set)
 *
 * Unlike Stacks 1/2/3/4, this SNS topic is published to by our own Step
 * Functions execution role (a normal IAM grant), not by an AWS service
 * principal — so no cross-service SNS topic policy is required here.
 */
export class BudgetsCostAnomalyDetectionCostDigestStack extends cdk.Stack {
    public readonly topic: sns.Topic;

    constructor(scope: Construct, id: string, props: BudgetsCostAnomalyDetectionCostDigestStackProps) {
        super(scope, id, props);

        const digestParams = props.params.costDigest;
        const notificationParams = props.params.notification;

        // This topic is published to by our own Step Functions execution role (a
        // normal IAM grant, wired below), not by an AWS service principal — so
        // none of the CostAlertTopic `allow*Publish` flags are needed here.
        const alertTopic = new CostAlertTopic(this, 'CostDigestTopic', {
            topicName: `${props.project}-${props.environment}-cost-digest`,
            emails: notificationParams.emails,
        });
        this.topic = alertTopic.topic;

        // -----------------------------------------------------------------------
        // Step Functions (JSONata): Cost Explorer → format → SNS publish
        // -----------------------------------------------------------------------
        const costSortedExpr =
            '(' +
            '$all_entries := $map(' +
            '$zip(' +
            '$states.result.ResultsByTime[].Groups[].Keys[0],' +
            '$states.result.ResultsByTime[].Groups[].Metrics.UnblendedCost.Amount.$number()' +
            '),' +
            'function($v) { {"Service": $v[0], "Amount": $v[1]} }' +
            ');' +
            '$services := $all_entries.Service ~> $distinct();' +
            '$cost_per_service := $map(' +
            '$services,' +
            'function($s){' +
            '{"Service": $s, "Total": $all_entries[Service=$s].Amount ~> $sum() ~> $round(1)}' +
            '}' +
            ');' +
            '$sort($cost_per_service, function($l, $r){ $l.Total < $r.Total });' +
            ')';

        const getCostAndUsage = new sfn.CustomState(this, 'GetCostAndUsage', {
            stateJson: {
                Type: 'Task',
                Resource: 'arn:aws:states:::aws-sdk:costexplorer:getCostAndUsage',
                Arguments: {
                    Granularity: 'MONTHLY',
                    Metrics: ['UnblendedCost'],
                    TimePeriod: {
                        Start: `{% ($millis() - 86400000 * ${digestParams.periodDays}) ~> $fromMillis('[Y0001]-[M01]-[D01]') %}`,
                        End: "{% $millis() ~> $fromMillis('[Y0001]-[M01]-[D01]') %}",
                    },
                    GroupBy: [{ Key: 'SERVICE', Type: 'DIMENSION' }],
                    Filter: { Not: { Dimensions: { Key: 'SERVICE', Values: ['Tax'] } } },
                },
                Assign: {
                    AngryThreshold: digestParams.angryThresholdUsd,
                    AccountId: cdk.Aws.ACCOUNT_ID,
                    Project: props.project,
                    Environment: props.environment,
                },
                Output: {
                    Start: '{% $states.result.ResultsByTime[0].TimePeriod.Start %}',
                    End: '{% $states.result.ResultsByTime[0].TimePeriod.End %}',
                    CostSum:
                        '{% $states.result.ResultsByTime[].Groups[].Metrics.UnblendedCost.Amount.$number() ' +
                        '~> $sum() ~> $round(1) %}',
                    CostSorted: `{% ${costSortedExpr} %}`,
                },
            },
        });

        const digestLocale = digestParams.locale ?? 'en';

        const publishCostDigest = new sfn.CustomState(this, 'PublishCostDigest', {
            stateJson: {
                Type: 'Task',
                Resource: 'arn:aws:states:::sns:publish',
                Arguments: {
                    Message: {
                        version: '1.0',
                        source: 'custom',
                        content: {
                            textType: 'client-markdown',
                            title: `{% ${buildCostDigestTitleExpression(digestLocale)} %}`,
                            description: `{% ${buildCostDigestDescriptionExpression(digestLocale, digestParams.periodDays)} %}`,
                        },
                    },
                    TopicArn: this.topic.topicArn,
                },
            },
        });

        getCostAndUsage.next(publishCostDigest);

        const stateMachineLogGroup = new logs.LogGroup(this, 'CostDigestStateMachineLogGroup', {
            logGroupName: `/aws/vendedlogs/states/${props.project}-${props.environment}-cost-digest`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
        });

        const stateMachine = new sfn.StateMachine(this, 'CostDigestStateMachine', {
            stateMachineName: `${props.project}-${props.environment}-cost-digest`,
            definitionBody: sfn.DefinitionBody.fromChainable(getCostAndUsage),
            queryLanguage: sfn.QueryLanguage.JSONATA,
            tracingEnabled: true,
            logs: {
                destination: stateMachineLogGroup,
                level: sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
        });

        // Cost Explorer does not support resource-level permissions for GetCostAndUsage.
        stateMachine.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
                actions: ['ce:GetCostAndUsage'],
                resources: ['*'],
            }),
        );
        this.topic.grantPublish(stateMachine.role);

        // -----------------------------------------------------------------------
        // EventBridge Scheduler: triggers the state machine on a cron schedule
        // -----------------------------------------------------------------------
        new scheduler.Schedule(this, 'CostDigestSchedule', {
            scheduleName: `${props.project}-${props.environment}-cost-digest`,
            description: 'Posts a rolling AWS cost digest to the configured chat channel(s)',
            schedule: scheduler.ScheduleExpression.expression(
                digestParams.scheduleExpression,
                digestParams.scheduleTimeZone,
            ),
            target: new scheduler_targets.StepFunctionsStartExecution(stateMachine, {}),
        });

        // -----------------------------------------------------------------------
        // Optional: Slack delivery via AWS Chatbot
        // -----------------------------------------------------------------------
        if (notificationParams.slack) {
            new SafeSlackChannelConfiguration(this, 'SlackChannelConfiguration', {
                slackChannelConfigurationName: `${props.project}-${props.environment}-cost-digest`,
                slackWorkspaceId: notificationParams.slack.workspaceId,
                slackChannelId: notificationParams.slack.channelId,
                notificationTopics: [this.topic],
                loggingLevel: chatbot.LoggingLevel.NONE,
            });
        }

        // -----------------------------------------------------------------------
        // Optional: Microsoft Teams delivery via AWS Chatbot
        // -----------------------------------------------------------------------
        if (notificationParams.teams) {
            new SafeMicrosoftTeamsChannelConfiguration(this, 'TeamsChannelConfiguration', {
                configurationName: `${props.project}-${props.environment}-cost-digest`,
                teamId: notificationParams.teams.teamId,
                teamsTenantId: notificationParams.teams.tenantId,
                teamsChannelId: notificationParams.teams.channelId,
                notificationTopics: [this.topic],
            });
        }
    }
}
