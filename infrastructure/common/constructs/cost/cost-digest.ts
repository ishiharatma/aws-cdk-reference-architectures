import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as chatbot from 'aws-cdk-lib/aws-chatbot';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as scheduler_targets from 'aws-cdk-lib/aws-scheduler-targets';
import { Construct } from 'constructs';
import { CostAlertTopic } from './cost-alert-topic';
import { SafeSlackChannelConfiguration } from './safe-slack-channel';
import { SafeMicrosoftTeamsChannelConfiguration } from './safe-teams-channel';

export interface CostDigestSlackParams {
    /** Slack workspace ID authorized in AWS Chatbot */
    readonly workspaceId: string;
    /** Slack channel ID to post notifications to */
    readonly channelId: string;
}

export interface CostDigestTeamsParams {
    /** Microsoft Teams team ID authorized in AWS Chatbot */
    readonly teamId: string;
    /** Microsoft Teams tenant ID */
    readonly tenantId: string;
    /** Microsoft Teams channel ID to post notifications to */
    readonly channelId: string;
}

export interface CostDigestProps {
    /** Used to name every resource this construct creates, e.g. `${project}-${environment}-cost-digest` */
    readonly project: string;
    readonly environment: string;
    /**
     * EventBridge Scheduler cron expression, e.g. 'cron(0 10 * * ? *)'.
     * The digest re-evaluates a rolling window (see periodDays) each run,
     * so a daily schedule posting the trailing N days is the common case.
     */
    readonly scheduleExpression: string;
    /**
     * Time zone the cron expression is interpreted in.
     * @default TimeZone.ASIA_TOKYO
     */
    readonly scheduleTimeZone?: cdk.TimeZone;
    /** Rolling window, in days, of cost data to summarize on each run. */
    readonly periodDays: number;
    /**
     * USD threshold above which the digest message uses an "angry" tone
     * instead of a "calm" one.
     */
    readonly angryThresholdUsd: number;
    /**
     * Language the digest message (title + description) is generated in.
     * @default 'en'
     */
    readonly locale?: 'ja' | 'en';
    /** Email addresses subscribed to the digest SNS topic. */
    readonly emails: string[];
    /**
     * Optional Slack channel (via AWS Chatbot) to also deliver the digest to.
     * @default undefined (Slack integration is skipped)
     */
    readonly slack?: CostDigestSlackParams;
    /**
     * Optional Microsoft Teams channel (via AWS Chatbot) to also deliver the digest to.
     * @default undefined (Teams integration is skipped)
     */
    readonly teams?: CostDigestTeamsParams;
    /**
     * Removal policy for the state machine's CloudWatch Logs log group.
     * @default cdk.RemovalPolicy.RETAIN
     */
    readonly logGroupRemovalPolicy?: cdk.RemovalPolicy;
}

/**
 * JSONata expression (no `{% %}` wrapper) for the digest message title, in
 * the requested locale.
 */
function buildCostDigestTitleExpression(locale: 'ja' | 'en'): string {
    if (locale === 'ja') {
        return '$states.input.CostSum > $AngryThreshold ? "😱 コストが跳ね上がっています" : "😊 コストは落ち着いています"';
    }
    return '$states.input.CostSum > $AngryThreshold ? "😱 Costs are spiking" : "😊 Costs are steady"';
}

/**
 * JSONata expression (no `{% %}` wrapper) for the digest message
 * description, in the requested locale. Built with explicit `\\n` (literal
 * backslash+n, not a real line break) so the JSONata source — after this
 * whole object round-trips through ASL/CFN JSON — still contains a JSONata
 * string-literal escape, not a raw control character.
 */
function buildCostDigestDescriptionExpression(locale: 'ja' | 'en', periodDays: number): string {
    if (locale === 'ja') {
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

/**
 * A scheduled, chat-native AWS cost digest: EventBridge Scheduler triggers a
 * Step Functions (JSONata) state machine that calls Cost Explorer's
 * `GetCostAndUsage` directly (no Lambda), formats a top-5-services-by-cost
 * markdown summary, and publishes it to SNS. AWS Chatbot optionally fans the
 * topic out to Slack and/or Microsoft Teams.
 *
 * Unlike cost-alerting constructs that react to a threshold being crossed,
 * this is a proactive "push" on a schedule — "tell me what we spent"
 * instead of "tell me if we spent too much."
 *
 * The SNS topic is published to by this construct's own Step Functions
 * execution role (a normal IAM grant), not by an AWS service principal, so
 * it does not need `CostAlertTopic`'s `allow*Publish` flags.
 */
export class CostDigest extends Construct {
    public readonly topic: sns.Topic;
    public readonly stateMachine: sfn.IStateMachine;

    constructor(scope: Construct, id: string, props: CostDigestProps) {
        super(scope, id);

        const namePrefix = `${props.project}-${props.environment}-cost-digest`;

        const alertTopic = new CostAlertTopic(this, 'Topic', {
            topicName: namePrefix,
            emails: props.emails,
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
                        Start: `{% ($millis() - 86400000 * ${props.periodDays}) ~> $fromMillis('[Y0001]-[M01]-[D01]') %}`,
                        End: "{% $millis() ~> $fromMillis('[Y0001]-[M01]-[D01]') %}",
                    },
                    GroupBy: [{ Key: 'SERVICE', Type: 'DIMENSION' }],
                    Filter: { Not: { Dimensions: { Key: 'SERVICE', Values: ['Tax'] } } },
                },
                Assign: {
                    AngryThreshold: props.angryThresholdUsd,
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

        const locale = props.locale ?? 'en';

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
                            title: `{% ${buildCostDigestTitleExpression(locale)} %}`,
                            description: `{% ${buildCostDigestDescriptionExpression(locale, props.periodDays)} %}`,
                        },
                    },
                    TopicArn: this.topic.topicArn,
                },
            },
        });

        getCostAndUsage.next(publishCostDigest);

        const stateMachineLogGroup = new logs.LogGroup(this, 'StateMachineLogGroup', {
            logGroupName: `/aws/vendedlogs/states/${namePrefix}`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: props.logGroupRemovalPolicy ?? cdk.RemovalPolicy.RETAIN,
        });

        const stateMachine = new sfn.StateMachine(this, 'StateMachine', {
            stateMachineName: namePrefix,
            definitionBody: sfn.DefinitionBody.fromChainable(getCostAndUsage),
            queryLanguage: sfn.QueryLanguage.JSONATA,
            tracingEnabled: true,
            logs: {
                destination: stateMachineLogGroup,
                level: sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
        });
        this.stateMachine = stateMachine;

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
        new scheduler.Schedule(this, 'Schedule', {
            scheduleName: namePrefix,
            description: 'Posts a rolling AWS cost digest to the configured chat channel(s)',
            schedule: scheduler.ScheduleExpression.expression(props.scheduleExpression, props.scheduleTimeZone),
            target: new scheduler_targets.StepFunctionsStartExecution(stateMachine, {}),
        });

        // -----------------------------------------------------------------------
        // Optional: Slack delivery via AWS Chatbot
        // -----------------------------------------------------------------------
        if (props.slack) {
            new SafeSlackChannelConfiguration(this, 'SlackChannelConfiguration', {
                slackChannelConfigurationName: namePrefix,
                slackWorkspaceId: props.slack.workspaceId,
                slackChannelId: props.slack.channelId,
                notificationTopics: [this.topic],
                loggingLevel: chatbot.LoggingLevel.NONE,
            });
        }

        // -----------------------------------------------------------------------
        // Optional: Microsoft Teams delivery via AWS Chatbot
        // -----------------------------------------------------------------------
        if (props.teams) {
            new SafeMicrosoftTeamsChannelConfiguration(this, 'TeamsChannelConfiguration', {
                configurationName: namePrefix,
                teamId: props.teams.teamId,
                teamsTenantId: props.teams.tenantId,
                teamsChannelId: props.teams.channelId,
                notificationTopics: [this.topic],
            });
        }
    }
}
