import * as logs from 'aws-cdk-lib/aws-logs';

export const defaultLogGroupArchiveConfig = {
    retention: logs.RetentionDays.ONE_MONTH,
    filterPattern: "",
};

/**
 * Parameters for the CloudWatch Log Group to be archived
 */
export interface LogGroupArchiveParams {
    /**
     * Optional suffix appended to the log group name: /{project}/{environment}/{suffix}
     * If not provided, CloudFormation generates the name.
     */
    readonly logGroupNameSuffix?: string;
    /**
     * Log retention period
     * @default RetentionDays.ONE_MONTH
     */
    readonly retention?: logs.RetentionDays;
    /**
     * CloudWatch Logs filter pattern for the subscription filter
     * Use "" to match all events, or a specific pattern to filter
     * @default "" (all events)
     */
    readonly filterPattern?: string;
}

/**
 * Parameters for importing an existing CloudWatch Log Group (Stack 3)
 */
export interface ExistingLogGroupParams {
    /**
     * The name of the existing CloudWatch Log Group to archive
     */
    readonly logGroupName: string;
    /**
     * CloudWatch Logs filter pattern for the subscription filter
     * @default "" (all events)
     */
    readonly filterPattern?: string;
}
