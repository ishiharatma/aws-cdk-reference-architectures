import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Environment } from '@common/parameters/environments';
import { CostAlertTopic, CostBudget } from '@common/constructs/cost';
import { EnvParams } from 'parameters/environments';

export interface BudgetsCostAnomalyDetectionBudgetStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

/**
 * Stack 1 – AWS Budgets alerts
 *
 * Creates an SNS topic (granted to budgets.amazonaws.com) and two cost
 * budgets that both publish to it:
 *   1. An account-wide monthly cost budget
 *   2. A service-filtered monthly cost budget (demonstrates costFilters)
 *
 * Each budget notifies according to `params.budget.notifications` (defaults
 * to ACTUAL 80%, ACTUAL 100% and FORECASTED 100% of the limit), fanning out
 * to the SNS topic and to email subscribers.
 *
 * Architecture:
 *   CfnBudget (x2) → SNS Topic → Email subscription(s)
 */
export class BudgetsCostAnomalyDetectionBudgetStack extends cdk.Stack {
    public readonly topic: sns.Topic;

    constructor(scope: Construct, id: string, props: BudgetsCostAnomalyDetectionBudgetStackProps) {
        super(scope, id, props);

        const budgetParams = props.params.budget;
        const notificationParams = props.params.notification;

        const alertTopic = new CostAlertTopic(this, 'BudgetAlertTopic', {
            topicName: `${props.project}-${props.environment}-budget-alerts`,
            emails: notificationParams.emails,
            allowBudgetsPublish: true,
        });
        this.topic = alertTopic.topic;

        // -----------------------------------------------------------------------
        // Budget 1: account-wide monthly cost budget
        // -----------------------------------------------------------------------
        new CostBudget(this, 'MonthlyCostBudget', {
            budgetName: `${props.project}-${props.environment}-monthly-cost`,
            amount: budgetParams.amount,
            unit: budgetParams.unit,
            notifications: budgetParams.notifications,
            topic: this.topic,
            emails: notificationParams.emails,
        });

        // -----------------------------------------------------------------------
        // Budget 2: service-filtered monthly cost budget (demonstrates costFilters)
        // -----------------------------------------------------------------------
        if (budgetParams.serviceFilter && budgetParams.serviceFilter.length > 0) {
            new CostBudget(this, 'ServiceCostBudget', {
                budgetName: `${props.project}-${props.environment}-service-cost`,
                amount: budgetParams.amount,
                unit: budgetParams.unit,
                costFilters: { Service: budgetParams.serviceFilter },
                notifications: budgetParams.notifications,
                topic: this.topic,
                emails: notificationParams.emails,
            });
        }
    }
}
