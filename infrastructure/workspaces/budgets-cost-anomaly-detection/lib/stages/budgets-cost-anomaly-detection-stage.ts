import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { BudgetsCostAnomalyDetectionBudgetStack } from 'lib/stacks/budgets-cost-anomaly-detection-budget-stack';
import { BudgetsCostAnomalyDetectionAnomalyStack } from 'lib/stacks/budgets-cost-anomaly-detection-anomaly-stack';
import { BudgetsCostAnomalyDetectionUnifiedStack } from 'lib/stacks/budgets-cost-anomaly-detection-unified-stack';
import { BudgetsCostAnomalyDetectionBillingAlarmStack } from 'lib/stacks/budgets-cost-anomaly-detection-billing-alarm-stack';
import { BudgetsCostAnomalyDetectionCostDigestStack } from 'lib/stacks/budgets-cost-anomaly-detection-cost-digest-stack';

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

/**
 * Budgets & Cost Anomaly Detection Stage
 *
 * Instantiates three stacks that demonstrate different FinOps alerting patterns:
 *
 *   Stack 1 (Budget)       – Pattern A: AWS Budgets thresholds → SNS → Email
 *   Stack 2 (Anomaly)      – Pattern B: Cost Anomaly Detection → SNS → Email
 *   Stack 3 (Unified)      – Pattern C: Budgets + Anomaly Detection on one SNS
 *                            topic, with optional Slack delivery via AWS Chatbot.
 *                            Depends on Stack 2: AWS allows only one AWS-managed
 *                            SERVICE anomaly monitor per account, so Stack 3
 *                            attaches an additional subscription to Stack 2's
 *                            monitor instead of creating a conflicting second one.
 *   Stack 4 (BillingAlarm) – Pattern D: classic CloudWatch EstimatedCharges
 *                            alarm → SNS → Email. Forced to us-east-1 because
 *                            the AWS/Billing metric is only ever published there.
 *   Stack 5 (CostDigest)   – Pattern E: scheduled Step Functions cost digest →
 *                            SNS → Slack and/or Microsoft Teams via AWS Chatbot
 */
export class BudgetsCostAnomalyDetectionStage extends cdk.Stage {
    constructor(scope: Construct, id: string, props: StageProps) {
        super(scope, id, props);

        const commonStackProps = {
            project: props.project,
            environment: props.environment,
            env: props.env,
            terminationProtection: props.terminationProtection,
            isAutoDeleteObject: props.isAutoDeleteObject,
            params: props.params,
        };

        // Stack 1: Pattern A – Budget alerts
        new BudgetsCostAnomalyDetectionBudgetStack(
            this,
            `${pascalCase(props.project)}${pascalCase('budgets-cost-anomaly-detection-budget')}`,
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-budget-alerts`,
                description: 'Stack 1 (Pattern A): AWS Budgets cost thresholds notifying via SNS and email',
            },
        );

        // Stack 2: Pattern B – Cost Anomaly Detection
        const anomalyStack = new BudgetsCostAnomalyDetectionAnomalyStack(
            this,
            `${pascalCase(props.project)}${pascalCase('budgets-cost-anomaly-detection-anomaly')}`,
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-cost-anomaly-detection`,
                description: 'Stack 2 (Pattern B): AWS Cost Anomaly Detection notifying via SNS',
            },
        );

        // Stack 3: Pattern C – Unified alerting with optional Slack delivery
        // Reuses Stack 2's anomaly monitor (see class doc on the Unified stack
        // for why) — this creates an explicit dependency on Stack 2.
        new BudgetsCostAnomalyDetectionUnifiedStack(
            this,
            `${pascalCase(props.project)}${pascalCase('budgets-cost-anomaly-detection-unified')}`,
            {
                ...commonStackProps,
                anomalyMonitorArn: anomalyStack.monitorArn,
                stackName: `${props.project}-${props.environment}-finops-unified-alerts`,
                description:
                    'Stack 3 (Pattern C): Budgets and Cost Anomaly Detection unified on one SNS topic, ' +
                    'optionally delivered to Slack via AWS Chatbot',
            },
        );

        // Stack 4: Pattern D – Classic CloudWatch billing alarm
        // The AWS/Billing EstimatedCharges metric is only ever published in
        // us-east-1, regardless of the project's configured region, so this
        // stack's env is pinned to us-east-1 rather than using commonStackProps.env.
        new BudgetsCostAnomalyDetectionBillingAlarmStack(
            this,
            `${pascalCase(props.project)}${pascalCase('budgets-cost-anomaly-detection-billing-alarm')}`,
            {
                ...commonStackProps,
                env: { account: props.env?.account, region: 'us-east-1' },
                stackName: `${props.project}-${props.environment}-billing-alarm`,
                description:
                    'Stack 4 (Pattern D): Classic CloudWatch EstimatedCharges billing alarm notifying via SNS ' +
                    'and email (us-east-1 only)',
            },
        );

        // Stack 5: Pattern E – Scheduled Step Functions cost digest to Slack/Teams
        new BudgetsCostAnomalyDetectionCostDigestStack(
            this,
            `${pascalCase(props.project)}${pascalCase('budgets-cost-anomaly-detection-cost-digest')}`,
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-cost-digest`,
                description:
                    'Stack 5 (Pattern E): Scheduled Step Functions cost digest, published to SNS and delivered ' +
                    'to Slack/Microsoft Teams via AWS Chatbot',
            },
        );
    }
}
