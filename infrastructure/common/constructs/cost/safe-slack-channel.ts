import * as iam from 'aws-cdk-lib/aws-iam';
import * as chatbot from 'aws-cdk-lib/aws-chatbot';
import { Construct } from 'constructs';

export interface SafeSlackChannelConfigurationProps extends Omit<chatbot.SlackChannelConfigurationProps, 'guardrailPolicies'> {
    /**
     * IAM managed policies applied as channel guardrails.
     *
     * AWS Chatbot applies the AWS-managed `AdministratorAccess` policy by
     * default when this is left unset — and CDK synth drops an explicit
     * empty array (`[]`) from the rendered template entirely, which leaves
     * the property unset at the API level and lets that default apply
     * anyway. This construct exists specifically to close that gap: when
     * omitted (or empty), it substitutes `ReadOnlyAccess` instead.
     * @default [iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')]
     */
    readonly guardrailPolicies?: iam.IManagedPolicy[];
}

/**
 * A `chatbot.SlackChannelConfiguration` that can never silently end up with
 * AWS Chatbot's `AdministratorAccess` guardrail default. Use this instead of
 * `SlackChannelConfiguration` directly for any notification-only channel.
 */
export class SafeSlackChannelConfiguration extends chatbot.SlackChannelConfiguration {
    constructor(scope: Construct, id: string, props: SafeSlackChannelConfigurationProps) {
        super(scope, id, {
            slackChannelConfigurationName: props.slackChannelConfigurationName,
            role: props.role,
            slackWorkspaceId: props.slackWorkspaceId,
            slackChannelId: props.slackChannelId,
            notificationTopics: props.notificationTopics,
            loggingLevel: props.loggingLevel,
            logRetention: props.logRetention,
            logRetentionRole: props.logRetentionRole,
            logRetentionRetryOptions: props.logRetentionRetryOptions,
            userRoleRequired: props.userRoleRequired,
            guardrailPolicies:
                props.guardrailPolicies && props.guardrailPolicies.length > 0
                    ? props.guardrailPolicies
                    : [iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')],
        });
    }
}
