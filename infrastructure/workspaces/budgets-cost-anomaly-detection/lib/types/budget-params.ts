export type { BudgetNotificationRule } from '@common/types/cost';
export { defaultBudgetNotifications } from '@common/types/cost';
import { BudgetNotificationRule } from '@common/types/cost';

export const defaultBudgetConfig = {
    unit: 'USD',
    timeUnit: 'MONTHLY' as const,
};

/**
 * Parameters for a single AWS Budgets cost budget (Stack 1)
 */
export interface BudgetThresholdParams {
    /**
     * Monthly budget limit amount
     */
    readonly amount: number;
    /**
     * Currency unit for the budget limit
     * @default 'USD'
     */
    readonly unit?: string;
    /**
     * Cost Explorer service name(s) to scope the budget to, e.g.
     * "Amazon Elastic Compute Cloud - Compute". Leave undefined for an
     * account-wide budget. Use `aws ce get-dimension-values --dimension SERVICE`
     * to look up the exact service name strings for your account.
     */
    readonly serviceFilter?: string[];
    /**
     * Notification rules (type + threshold %) applied to every budget in
     * this stack. Add or remove entries to change how many/which alerts
     * fire — e.g. append `{ type: 'ACTUAL', thresholdPercent: 200 }` for a
     * runaway-cost escalation notification.
     * @default defaultBudgetNotifications
     */
    readonly notifications?: BudgetNotificationRule[];
}
