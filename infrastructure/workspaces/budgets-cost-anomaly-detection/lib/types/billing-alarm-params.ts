/**
 * Parameters for the classic CloudWatch "EstimatedCharges" billing alarm (Stack 4)
 */
export interface BillingAlarmParams {
    /**
     * USD threshold above which the alarm goes into ALARM state.
     * Compared against the AWS/Billing EstimatedCharges metric, which is the
     * account's cumulative estimated charge for the current billing period.
     */
    readonly thresholdUsd: number;
}
