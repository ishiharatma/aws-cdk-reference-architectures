import * as sns from 'aws-cdk-lib/aws-sns';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';
import { BudgetNotificationRule, defaultBudgetNotifications } from '../../types/cost';

export interface CostBudgetProps {
    /** Name of the budget */
    readonly budgetName: string;
    /** Budget limit amount */
    readonly amount: number;
    /**
     * Currency unit for the budget limit
     * @default 'USD'
     */
    readonly unit?: string;
    /**
     * Budget time unit
     * @default 'MONTHLY'
     */
    readonly timeUnit?: string;
    /**
     * Cost Explorer cost filters, e.g. `{ Service: ['Amazon Elastic Compute Cloud - Compute'] }`.
     * Omit for an account-wide budget.
     */
    readonly costFilters?: Record<string, string[]>;
    /**
     * Notification rules (type + threshold %). A plain array so callers can
     * add/remove thresholds via configuration instead of code.
     * @default defaultBudgetNotifications (forecasted 100%, actual 80%, actual 100%)
     */
    readonly notifications?: BudgetNotificationRule[];
    /** SNS topic to notify — must already permit `budgets.amazonaws.com` to publish (see `CostAlertTopic`) */
    readonly topic: sns.ITopic;
    /**
     * Email addresses to notify directly from the budget notification (in
     * addition to the SNS topic). AWS Budgets allows up to 10 per notification.
     */
    readonly emails: string[];
}

/**
 * An `AWS::Budgets::Budget` (`COST` type) whose notification thresholds are
 * driven entirely by data (`BudgetNotificationRule[]`) rather than hard-coded
 * in construct/stack code.
 */
export class CostBudget extends Construct {
    public readonly budget: budgets.CfnBudget;

    constructor(scope: Construct, id: string, props: CostBudgetProps) {
        super(scope, id);

        const subscribers: budgets.CfnBudget.SubscriberProperty[] = [
            { subscriptionType: 'SNS', address: props.topic.topicArn },
            ...props.emails.map(
                (email): budgets.CfnBudget.SubscriberProperty => ({ subscriptionType: 'EMAIL', address: email }),
            ),
        ];

        const notificationRules = props.notifications ?? defaultBudgetNotifications;
        const notificationsWithSubscribers: budgets.CfnBudget.NotificationWithSubscribersProperty[] =
            notificationRules.map((rule) => ({
                notification: {
                    notificationType: rule.type,
                    comparisonOperator: 'GREATER_THAN',
                    threshold: rule.thresholdPercent,
                    thresholdType: 'PERCENTAGE',
                },
                subscribers,
            }));

        this.budget = new budgets.CfnBudget(this, 'Resource', {
            budget: {
                budgetName: props.budgetName,
                budgetType: 'COST',
                timeUnit: props.timeUnit ?? 'MONTHLY',
                budgetLimit: {
                    amount: props.amount,
                    unit: props.unit ?? 'USD',
                },
                costFilters: props.costFilters,
            },
            notificationsWithSubscribers,
        });
    }
}
