// Common tag definitions
export interface CommonTags {
    Environment: string;
    Project: string;
    Owner?: string;
    CostCenter?: string;
    Application?: string;
}

// Log level
export enum LogLevel {
    DEBUG = 'debug',
    INFO = 'info',
    WARN = 'warn',
    ERROR = 'error',
}
/**
 * Special ID for shortening logical IDs in CDK
 *
 * @see https://dev.classmethod.jp/articles/best-way-to-name-aws-cdk-construct-id/
 */
export const C_DEFAULT = "Default";
export const C_RESOURCE = "Resource";

/**
 * Allowed IP ranges for "all IPv6 addresses" and "all IPv4 addresses" used in security group rules
 * and allowed country codes for Japan
 */
export const allowedAllIpV6AddressRanges = [
    "::/1",
    "8000::/1",
];
export const allowedAllIpV4AddressRanges = [
    "0.0.0.0/1",
    "128.0.0.0/1",
]
export const allowedCountryCodesJP = [
    "JP",
];

export type CronExpression = `cron(${string})`;
export interface startstopSchedulerConfig {
    /**
     * Cron expression for start schedule
     * Specified in UTC
     * @example "cron(0 0 * * ? *)" // Start at 9:00 JST every day
     * @example "cron(0 0 ? * MON-FRI *)" // Start at 9:00 JST on Mon-Fri
     */
    readonly startCronSchedule: CronExpression;
    /**
     * Cron expression for stop schedule
     * Specified in UTC
     * @example "cron(0 9 * * ? *)" // Stop at 18:00 JST every day
     * @example "cron(0 9 ? * MON-FRI *)" // Stop at 18:00 JST on Mon-Fri
     */
    readonly stopCronSchedule: CronExpression;
}
