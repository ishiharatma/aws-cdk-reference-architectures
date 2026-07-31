import {
    BudgetThresholdParams,
    AnomalyDetectionParams,
    NotificationParams,
    BillingAlarmParams,
    CostDigestParams,
} from 'lib/types';
import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type for budgets-cost-anomaly-detection
 */
export interface EnvParams extends EnvironmentConfig {
    /** Monthly cost budget configuration (Stacks 1 and 3) */
    readonly budget: BudgetThresholdParams;
    /** Cost Anomaly Detection thresholds (Stacks 2 and 3) */
    readonly anomalyDetection: AnomalyDetectionParams;
    /** Notification targets (email + optional Slack/Teams) shared by all stacks */
    readonly notification: NotificationParams;
    /** Classic CloudWatch EstimatedCharges billing alarm threshold (Stack 4) */
    readonly billingAlarm: BillingAlarmParams;
    /** Scheduled cost-digest-to-chat configuration (Stack 5) */
    readonly costDigest: CostDigestParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
