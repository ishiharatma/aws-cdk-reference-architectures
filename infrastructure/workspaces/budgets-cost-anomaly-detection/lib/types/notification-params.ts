/**
 * Slack notification target, delivered via AWS Chatbot (Stacks 3 and 5).
 * Both fields are required to enable the Slack integration; omit the whole
 * `slack` object to skip AWS Chatbot and rely on email/SNS only.
 */
export interface SlackNotificationParams {
    /** Slack workspace ID authorized in AWS Chatbot */
    readonly workspaceId: string;
    /** Slack channel ID to post notifications to */
    readonly channelId: string;
}

/**
 * Microsoft Teams notification target, delivered via AWS Chatbot (Stack 5 only).
 * All three fields are required to enable the Teams integration; omit the
 * whole `teams` object to skip it.
 */
export interface TeamsNotificationParams {
    /** Microsoft Teams team ID authorized in AWS Chatbot */
    readonly teamId: string;
    /** Microsoft Teams tenant ID */
    readonly tenantId: string;
    /** Microsoft Teams channel ID to post notifications to */
    readonly channelId: string;
}

/**
 * Notification targets shared across all stacks
 */
export interface NotificationParams {
    /**
     * Email addresses subscribed to budget / anomaly SNS topics.
     * AWS Budgets allows up to 10 email subscribers per notification.
     */
    readonly emails: string[];
    /**
     * Optional Slack channel (via AWS Chatbot) for the unified stack (Stack 3)
     * and/or the cost digest stack (Stack 5).
     * @default undefined (Slack integration is skipped)
     */
    readonly slack?: SlackNotificationParams;
    /**
     * Optional Microsoft Teams channel (via AWS Chatbot) for the cost digest
     * stack (Stack 5).
     * @default undefined (Teams integration is skipped)
     */
    readonly teams?: TeamsNotificationParams;
}
