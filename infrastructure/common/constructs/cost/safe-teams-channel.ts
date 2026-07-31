import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as chatbot from 'aws-cdk-lib/aws-chatbot';
import { Construct } from 'constructs';

export interface SafeMicrosoftTeamsChannelConfigurationProps {
    /** Name of the configuration */
    readonly configurationName: string;
    /** Microsoft Teams team ID authorized in AWS Chatbot */
    readonly teamId: string;
    /** Microsoft Teams tenant ID */
    readonly teamsTenantId: string;
    /** Microsoft Teams channel ID to post notifications to */
    readonly teamsChannelId: string;
    /** SNS topics that deliver notifications to this channel */
    readonly notificationTopics?: sns.ITopic[];
    /**
     * IAM role AWS Chatbot assumes for this configuration.
     * @default a minimal "notifications-only" role (cloudwatch Describe/Get/List actions
     * on all resources, mirroring AWS's own sample Chatbot notifications-only policy)
     */
    readonly role?: iam.IRole;
    /**
     * IAM managed policy ARNs applied as channel guardrails.
     *
     * `AWS::Chatbot::MicrosoftTeamsChannelConfiguration` applies the
     * AWS-managed `AdministratorAccess` policy by default when this is left
     * unset — regardless of how minimal the `role` above is. This
     * construct exists specifically to close that gap: when omitted, it
     * substitutes `ReadOnlyAccess` instead.
     * @default [ReadOnlyAccess managed policy ARN]
     */
    readonly guardrailPolicies?: string[];
    /**
     * Logging level for this configuration.
     * @default 'NONE'
     */
    readonly loggingLevel?: string;
}

/**
 * An `AWS::Chatbot::MicrosoftTeamsChannelConfiguration` that can never
 * silently end up with AWS Chatbot's `AdministratorAccess` guardrail
 * default, and that creates a least-privilege IAM role by default (there is
 * no L2 construct for Microsoft Teams in aws-cdk-lib, so both the role and
 * the guardrail policy must be supplied explicitly).
 */
export class SafeMicrosoftTeamsChannelConfiguration extends Construct {
    public readonly role: iam.IRole;
    public readonly configuration: chatbot.CfnMicrosoftTeamsChannelConfiguration;

    constructor(scope: Construct, id: string, props: SafeMicrosoftTeamsChannelConfigurationProps) {
        super(scope, id);

        if (props.role) {
            this.role = props.role;
        } else {
            const role = new iam.Role(this, 'ChatbotRole', {
                assumedBy: new iam.ServicePrincipal('chatbot.amazonaws.com'),
            });
            role.addToPrincipalPolicy(
                new iam.PolicyStatement({
                    actions: ['cloudwatch:Describe*', 'cloudwatch:Get*', 'cloudwatch:List*'],
                    resources: ['*'],
                }),
            );
            this.role = role;
        }

        this.configuration = new chatbot.CfnMicrosoftTeamsChannelConfiguration(this, 'Resource', {
            configurationName: props.configurationName,
            iamRoleArn: this.role.roleArn,
            teamId: props.teamId,
            teamsTenantId: props.teamsTenantId,
            teamsChannelId: props.teamsChannelId,
            snsTopicArns: props.notificationTopics?.map((topic) => topic.topicArn),
            loggingLevel: props.loggingLevel ?? 'NONE',
            guardrailPolicies:
                props.guardrailPolicies && props.guardrailPolicies.length > 0
                    ? props.guardrailPolicies
                    : [iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess').managedPolicyArn],
        });
    }
}
