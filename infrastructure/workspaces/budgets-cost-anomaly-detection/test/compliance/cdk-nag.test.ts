import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { BudgetsCostAnomalyDetectionBudgetStack } from 'lib/stacks/budgets-cost-anomaly-detection-budget-stack';
import { BudgetsCostAnomalyDetectionAnomalyStack } from 'lib/stacks/budgets-cost-anomaly-detection-anomaly-stack';
import { BudgetsCostAnomalyDetectionUnifiedStack } from 'lib/stacks/budgets-cost-anomaly-detection-unified-stack';
import { BudgetsCostAnomalyDetectionBillingAlarmStack } from 'lib/stacks/budgets-cost-anomaly-detection-billing-alarm-stack';
import { BudgetsCostAnomalyDetectionCostDigestStack } from 'lib/stacks/budgets-cost-anomaly-detection-cost-digest-stack';
import { params } from 'parameters/environments';
import 'test/parameters';
import * as path from 'path';
import { loadCdkContext } from '@common/test-helpers/test-context';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = 'example';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const cdkJsonPath = path.resolve(__dirname, '../../cdk.json');
const baseContext = loadCdkContext(cdkJsonPath);

function nagTestSuite(
    suiteName: string,
    buildStack: (app: cdk.App) => cdk.Stack,
    suppressFn: (stack: cdk.Stack) => void,
) {
    describe(`CDK Nag AwsSolutions Pack – ${suiteName}`, () => {
        let app: cdk.App;
        let stack: cdk.Stack;

        beforeAll(() => {
            app = new cdk.App({ context: baseContext });
            stack = buildStack(app);
            suppressFn(stack);
            cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
        });

        test('No unsuppressed Warnings', () => {
            const warnings = Annotations.fromStack(stack).findWarning(
                '*',
                Match.stringLikeRegexp('AwsSolutions-.*'),
            );
            if (warnings.length > 0) {
                console.log('\n=== CDK Nag Warnings ===');
                warnings.forEach((w, i) => {
                    console.log(`\nWarning ${i + 1}:`);
                    console.log(`  Path: ${w.id}`);
                    console.log(`  Entry:`, JSON.stringify(w.entry, null, 2));
                });
                console.log('======================\n');
            }
            expect(warnings).toHaveLength(0);
        });

        test('No unsuppressed Errors', () => {
            const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
            if (errors.length > 0) {
                console.log('\n=== CDK Nag Errors ===');
                errors.forEach((e, i) => {
                    console.log(`\nError ${i + 1}:`);
                    console.log(`  Path: ${e.id}`);
                    console.log(`  Entry:`, JSON.stringify(e.entry, null, 2));
                });
                console.log('======================\n');
            }
            expect(errors).toHaveLength(0);
        });
    });
}

/**
 * Every stack's SNS topic must be publishable by budgets.amazonaws.com and/or
 * costalerts.amazonaws.com. AWS documents topic encryption with a
 * customer-managed KMS key as a common cause of silently dropped
 * notifications for both services, so these topics intentionally stay on
 * the default (unencrypted-at-rest) SNS-managed configuration; in-transit
 * encryption is still enforced (enforceSSL, satisfies AwsSolutions-SNS3).
 */
function suppressSns2(stack: cdk.Stack, topicResourceName: string): void {
    NagSuppressions.addResourceSuppressionsByPath(stack, `/${stack.stackName}/${topicResourceName}/Resource`, [
        {
            id: 'AwsSolutions-SNS2',
            reason:
                'A customer-managed KMS key would require cross-service key-policy grants to ' +
                'budgets.amazonaws.com / costalerts.amazonaws.com, which AWS documents as a common cause of ' +
                'silently dropped alert notifications. In-transit encryption is enforced via enforceSSL.',
        },
    ]);
}

// ============================================================================
// Stack 1: Budget alerts
// ============================================================================
nagTestSuite(
    'BudgetsCostAnomalyDetectionBudgetStack',
    (app) =>
        new BudgetsCostAnomalyDetectionBudgetStack(app, `${projectName}-${envName}-budget`, {
            project: projectName,
            environment: envName,
            isAutoDeleteObject: false,
            terminationProtection: false,
            env: defaultEnv,
            params: envParams,
        }),
    (stack) => suppressSns2(stack, 'BudgetAlertTopic'),
);

// ============================================================================
// Stack 2: Cost Anomaly Detection
// ============================================================================
nagTestSuite(
    'BudgetsCostAnomalyDetectionAnomalyStack',
    (app) =>
        new BudgetsCostAnomalyDetectionAnomalyStack(app, `${projectName}-${envName}-anomaly`, {
            project: projectName,
            environment: envName,
            isAutoDeleteObject: false,
            terminationProtection: false,
            env: defaultEnv,
            params: envParams,
        }),
    (stack) => suppressSns2(stack, 'CostAnomalyTopic'),
);

// ============================================================================
// Stack 3: Unified alerting with optional Slack delivery
// ============================================================================
nagTestSuite(
    'BudgetsCostAnomalyDetectionUnifiedStack',
    (app) =>
        new BudgetsCostAnomalyDetectionUnifiedStack(app, `${projectName}-${envName}-unified`, {
            project: projectName,
            environment: envName,
            isAutoDeleteObject: false,
            terminationProtection: false,
            env: defaultEnv,
            params: envParams,
            anomalyMonitorArn: 'arn:aws:ce::123456789012:anomalymonitor/test-monitor-id',
        }),
    (stack) => suppressSns2(stack, 'FinOpsAlertTopic'),
);

// ============================================================================
// Stack 4: Classic CloudWatch billing alarm
// ============================================================================
nagTestSuite(
    'BudgetsCostAnomalyDetectionBillingAlarmStack',
    (app) =>
        new BudgetsCostAnomalyDetectionBillingAlarmStack(app, `${projectName}-${envName}-billing-alarm`, {
            project: projectName,
            environment: envName,
            isAutoDeleteObject: false,
            terminationProtection: false,
            env: { ...defaultEnv, region: 'us-east-1' },
            params: envParams,
        }),
    (stack) => suppressSns2(stack, 'BillingAlarmTopic'),
);

// ============================================================================
// Stack 5: Scheduled cost digest to Slack/Teams
// ============================================================================
nagTestSuite(
    'BudgetsCostAnomalyDetectionCostDigestStack',
    (app) =>
        new BudgetsCostAnomalyDetectionCostDigestStack(app, `${projectName}-${envName}-cost-digest`, {
            project: projectName,
            environment: envName,
            isAutoDeleteObject: false,
            terminationProtection: false,
            env: defaultEnv,
            params: envParams,
        }),
    (stack) => {
        suppressSns2(stack, 'CostDigestTopic');
        // Cost Explorer's GetCostAndUsage does not support resource-level permissions;
        // the wildcard resource is required by the API itself.
        NagSuppressions.addResourceSuppressionsByPath(
            stack,
            `/${stack.stackName}/CostDigestStateMachine/Role/DefaultPolicy/Resource`,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'ce:GetCostAndUsage does not support resource-level permissions; the wildcard resource is ' +
                        'required by the Cost Explorer API.',
                    appliesTo: ['Resource::*'],
                },
            ],
        );
    },
);
