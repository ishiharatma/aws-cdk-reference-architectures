import * as cdk from 'aws-cdk-lib';

export const defaultCostDigestConfig = {
    scheduleTimeZone: cdk.TimeZone.ASIA_TOKYO,
};

/**
 * Parameters for the scheduled cost-digest-to-chat pattern (Stack 5)
 */
export interface CostDigestParams {
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
    /**
     * Rolling window, in days, of cost data to summarize on each run.
     */
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
}
