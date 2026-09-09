import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as path from 'path';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface AppStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly table: dynamodb.ITable;
}

/**
 * Application stack: 5 Lambda functions + a Step Functions Standard state
 * machine implementing the order-processing Saga.
 *
 * Forward path (3 steps):
 *   ReserveInventory -> ProcessPayment -> ConfirmOrder -> Succeed
 *
 * Each forward step is wrapped with Retry (2 attempts, 2s initial interval,
 * backoff x2) so a transient failure resolves itself before the Saga gives
 * up. When retries are exhausted, Catch routes to a Fail state, running the
 * appropriate compensating transaction(s) first:
 *
 *   ReserveInventory fails  -> Fail (nothing was reserved yet, no compensation)
 *   ProcessPayment fails    -> ReleaseInventory -> Fail
 *   ConfirmOrder fails      -> RefundPayment -> ReleaseInventory -> Fail
 *
 * FIS cannot target Step Functions directly (no FIS action exists for the
 * service). Instead, `aws:lambda:put-function-concurrent-executions` sets a
 * target Lambda's reserved concurrency to 0 in FisStack, which makes that
 * Lambda completely uninvokable. Every Lambda invocation from within the
 * state machine then throws Lambda.TooManyRequestsException, which drives
 * the Retry/Catch/compensation logic below exactly as it would for a real
 * outage — without needing to touch the state machine itself.
 */
export class AppStack extends cdk.Stack {
    public readonly reserveInventoryFn: lambda.Function;
    public readonly processPaymentFn: lambda.Function;
    public readonly confirmOrderFn: lambda.Function;
    public readonly releaseInventoryFn: lambda.Function;
    public readonly refundPaymentFn: lambda.Function;
    public readonly stateMachine: sfn.StateMachine;

    constructor(scope: Construct, id: string, props: AppStackProps) {
        super(scope, id, props);

        const removalPolicy = props.isAutoDeleteObject
            ? cdk.RemovalPolicy.DESTROY
            : cdk.RemovalPolicy.RETAIN;

        // --- Lambda functions ---
        // All 5 are simple mock implementations: each writes a single status
        // field to the order's DynamoDB record and returns. They exist as
        // Step Functions task targets and as FIS blast-radius targets — not
        // as production-grade business logic.

        const makeFn = (
            name: string,
            asset: string,
            description: string,
        ): lambda.Function => {
            const logGroup = new logs.LogGroup(this, `${name}LogGroup`, {
                logGroupName: `/aws/lambda/${props.project}-${props.environment}-${asset}`,
                retention: logs.RetentionDays.ONE_WEEK,
                removalPolicy,
            });

            const fn = new lambda.Function(this, name, {
                functionName: `${props.project}-${props.environment}-${asset}`,
                description,
                runtime: lambda.Runtime.PYTHON_3_13,
                handler: 'index.handler',
                code: lambda.Code.fromAsset(path.join(__dirname, `../../lambda/${asset}`)),
                environment: {
                    TABLE_NAME: props.table.tableName,
                },
                timeout: cdk.Duration.seconds(10),
                memorySize: 128,
                logGroup,
            });

            props.table.grantReadWriteData(fn);
            return fn;
        };

        this.reserveInventoryFn = makeFn(
            'ReserveInventoryFunction',
            'reserve-inventory',
            'Saga step 1 (forward): reserve inventory for the order',
        );
        this.processPaymentFn = makeFn(
            'ProcessPaymentFunction',
            'process-payment',
            'Saga step 2 (forward): process customer payment',
        );
        this.confirmOrderFn = makeFn(
            'ConfirmOrderFunction',
            'confirm-order',
            'Saga step 3 (forward, final): confirm the order',
        );
        this.releaseInventoryFn = makeFn(
            'ReleaseInventoryFunction',
            'release-inventory',
            'Saga compensation: release previously reserved inventory',
        );
        this.refundPaymentFn = makeFn(
            'RefundPaymentFunction',
            'refund-payment',
            'Saga compensation: refund a previously processed payment',
        );

        // --- Step Functions state machine ---

        const retryProps: sfn.RetryProps = {
            errors: [sfn.Errors.ALL],
            interval: cdk.Duration.seconds(2),
            maxAttempts: 2,
            backoffRate: 2,
        };

        // Terminal states -----------------------------------------------------

        const orderSucceeded = new sfn.Succeed(this, 'OrderSucceeded', {
            comment: 'All 3 forward steps completed — order confirmed.',
        });

        const orderFailedNoCompensation = new sfn.Fail(this, 'OrderFailedNoCompensationNeeded', {
            error: 'ReserveInventoryFailed',
            cause:
                'Inventory reservation failed before any resource was committed — ' +
                'no compensating transaction is required.',
        });

        const orderFailedAfterRelease = new sfn.Fail(this, 'OrderFailedAfterInventoryReleased', {
            error: 'ProcessPaymentFailed',
            cause:
                'Payment processing failed after inventory was reserved. ' +
                'Compensation complete: inventory has been released.',
        });

        const orderFailedAfterFullCompensation = new sfn.Fail(
            this,
            'OrderFailedAfterFullCompensation',
            {
                error: 'ConfirmOrderFailed',
                cause:
                    'Order confirmation failed after payment was processed. ' +
                    'Compensation complete, in order: payment refunded, then inventory released.',
            },
        );

        // Compensation chain for ConfirmOrder failure: Refund -> Release -> Fail
        // (2-stage compensation, executed in reverse order of the forward steps)

        const releaseInventoryAfterConfirmFailure = new tasks.LambdaInvoke(
            this,
            'ReleaseInventoryCompensation2',
            {
                lambdaFunction: this.releaseInventoryFn,
                payloadResponseOnly: true,
                comment: 'Compensating transaction 2/2 for a ConfirmOrder failure',
            },
        ).next(orderFailedAfterFullCompensation);

        const refundPaymentAfterConfirmFailure = new tasks.LambdaInvoke(
            this,
            'RefundPaymentCompensation1',
            {
                lambdaFunction: this.refundPaymentFn,
                payloadResponseOnly: true,
                comment: 'Compensating transaction 1/2 for a ConfirmOrder failure',
            },
        ).next(releaseInventoryAfterConfirmFailure);

        // Compensation for ProcessPayment failure: Release -> Fail

        const releaseInventoryAfterPaymentFailure = new tasks.LambdaInvoke(
            this,
            'ReleaseInventoryCompensation',
            {
                lambdaFunction: this.releaseInventoryFn,
                payloadResponseOnly: true,
                comment: 'Compensating transaction for a ProcessPayment failure',
            },
        ).next(orderFailedAfterRelease);

        // Forward steps, wired last-to-first so `.next()` targets already exist

        const confirmOrder = new tasks.LambdaInvoke(this, 'ConfirmOrder', {
            lambdaFunction: this.confirmOrderFn,
            payloadResponseOnly: true,
            comment: 'Saga step 3 (forward, final)',
        });
        confirmOrder.addRetry(retryProps);
        confirmOrder.addCatch(refundPaymentAfterConfirmFailure, {
            errors: [sfn.Errors.ALL],
            resultPath: '$.error',
        });
        confirmOrder.next(orderSucceeded);

        const processPayment = new tasks.LambdaInvoke(this, 'ProcessPayment', {
            lambdaFunction: this.processPaymentFn,
            payloadResponseOnly: true,
            comment: 'Saga step 2 (forward)',
        });
        processPayment.addRetry(retryProps);
        processPayment.addCatch(releaseInventoryAfterPaymentFailure, {
            errors: [sfn.Errors.ALL],
            resultPath: '$.error',
        });
        processPayment.next(confirmOrder);

        const reserveInventory = new tasks.LambdaInvoke(this, 'ReserveInventory', {
            lambdaFunction: this.reserveInventoryFn,
            payloadResponseOnly: true,
            comment: 'Saga step 1 (forward)',
        });
        reserveInventory.addRetry(retryProps);
        reserveInventory.addCatch(orderFailedNoCompensation, {
            errors: [sfn.Errors.ALL],
            resultPath: '$.error',
        });
        reserveInventory.next(processPayment);

        // --- State machine log group ---

        const sfnLogGroup = new logs.LogGroup(this, 'SagaStateMachineLogGroup', {
            logGroupName: `/aws/vendedlogs/states/${props.project}-${props.environment}-saga`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy,
        });

        this.stateMachine = new sfn.StateMachine(this, 'SagaStateMachine', {
            stateMachineName: `${props.project}-${props.environment}-order-saga`,
            stateMachineType: sfn.StateMachineType.STANDARD,
            definitionBody: sfn.DefinitionBody.fromChainable(reserveInventory),
            timeout: cdk.Duration.minutes(5),
            tracingEnabled: true,
            logs: {
                destination: sfnLogGroup,
                level: sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
        });

        // --- Outputs ---

        new cdk.CfnOutput(this, 'StateMachineArn', {
            value: this.stateMachine.stateMachineArn,
            description: 'Order Saga Step Functions state machine ARN',
        });
        new cdk.CfnOutput(this, 'ReserveInventoryFunctionArn', {
            value: this.reserveInventoryFn.functionArn,
            description: 'ReserveInventory Lambda function ARN',
        });
        new cdk.CfnOutput(this, 'ProcessPaymentFunctionArn', {
            value: this.processPaymentFn.functionArn,
            description: 'ProcessPayment Lambda function ARN',
        });
        new cdk.CfnOutput(this, 'ConfirmOrderFunctionArn', {
            value: this.confirmOrderFn.functionArn,
            description: 'ConfirmOrder Lambda function ARN',
        });
    }
}
