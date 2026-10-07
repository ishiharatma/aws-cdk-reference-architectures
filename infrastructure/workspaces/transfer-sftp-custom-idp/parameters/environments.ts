import { Environment, EnvironmentConfig } from "@common/parameters/environments";

/**
 * Environment parameters type
 */
/** How the Transfer Family server is run. A stopped server is still billed, so "off" means deleted. */
export type ServerMode = 'always' | 'scheduled' | 'manual';

export interface ServerLifecycle {
    /**
     * always:    the server is a CloudFormation resource and always runs.
     * manual:    no server after deploy; a Lambda creates it (start) and deletes it (stop) on request.
     * scheduled: like manual, plus EventBridge Scheduler calls start and stop on a schedule.
     */
    readonly mode: ServerMode;
    /** scheduled mode only. EventBridge Scheduler expressions, e.g. cron(0 8 ? * MON-FRI *). */
    readonly startExpression?: string;
    readonly stopExpression?: string;
    /** scheduled mode only. IANA time zone, e.g. Asia/Tokyo. */
    readonly timezone?: string;
    /**
     * Secrets Manager secret holding an OpenSSH private host key (plain text). When set, the on-demand
     * server is created with this host key so clients see the same fingerprint after every re-creation.
     */
    readonly hostKeySecretArn?: string;
}

export interface MonitoringParams {
    /** Create the alarms and the SNS topic. */
    readonly enabled: boolean;
    /** Email addresses subscribed to the alert topic (each address must confirm the subscription). */
    readonly alertEmails?: string[];
    /** Alarm evaluation period in minutes. */
    readonly periodMinutes: number;
    /** Authentication failures (Transfer Family AUTH_FAILURE events) per period that raise the alarm. */
    readonly authFailureThreshold: number;
    /** Logins rejected because of the source IP allow list, per period. */
    readonly ipDeniedThreshold: number;
    /** Data uploaded to / downloaded from the server per period, in MB. */
    readonly bytesInThresholdMb: number;
    readonly bytesOutThresholdMb: number;
}

export interface EnvParams extends EnvironmentConfig {
    /** Transfer Family security policy name (cryptographic algorithm set). */
    readonly securityPolicyName: string;
    /** Lambda / Transfer structured log retention in days (a valid CloudWatch Logs retention value). */
    readonly logRetentionDays: number;
    /**
     * Mask the SSH public key body that Transfer Family writes in its CONNECTED log events (CloudWatch Logs data
     * protection policy). Principals with logs:Unmask can still read the original.
     */
    readonly maskSshPublicKeyInLogs: boolean;
    /** Encrypt CloudWatch Logs log groups with a customer managed KMS key. */
    readonly enableLogEncryption: boolean;
    /** Lambda log level (INFO / DEBUG). */
    readonly lambdaLogLevel: 'INFO' | 'DEBUG';
    /** Server run mode (always on / scheduled / manual). */
    readonly serverLifecycle: ServerLifecycle;
    /** Alarms and the SNS topic. */
    readonly monitoring: MonitoringParams;
    /** Keep the SFTP data bucket and user table on stack deletion. */
    readonly retainData: boolean;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
