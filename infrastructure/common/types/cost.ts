/**
 * Common cost-alerting type definitions (AWS Budgets, Cost Anomaly Detection)
 */

/**
 * A single budget notification rule: "notify when {type} cost/forecast
 * exceeds {thresholdPercent}% of the budget limit".
 *
 * Kept as a plain data shape so callers can add/remove thresholds (e.g. an
 * "ACTUAL 200%" runaway-cost escalation) via configuration instead of code.
 */
export interface BudgetNotificationRule {
    /**
     * Whether this rule watches actual spend-to-date or the forecasted
     * end-of-period spend.
     */
    readonly type: 'ACTUAL' | 'FORECASTED';
    /**
     * Percentage of the budget limit that triggers this notification, e.g.
     * 80 for "80% of the budget".
     */
    readonly thresholdPercent: number;
}

/**
 * Default notification rules: forecasted cost > 100%, actual cost > 80%,
 * actual cost > 100%.
 */
export const defaultBudgetNotifications: BudgetNotificationRule[] = [
    { type: 'FORECASTED', thresholdPercent: 100 },
    { type: 'ACTUAL', thresholdPercent: 80 },
    { type: 'ACTUAL', thresholdPercent: 100 },
];
