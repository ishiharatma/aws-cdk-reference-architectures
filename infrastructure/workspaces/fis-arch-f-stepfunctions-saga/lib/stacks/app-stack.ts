import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as path from 'path';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

/**
 * S3 key prefix under which AWS FIS writes active Lambda fault configurations
 * and the AWS FIS Lambda extension reads them. Shared by AppStack (extension
 * env var + read grant) and FisStack (write grant).
 */
export const FIS_CONFIG_PREFIX = 'FisConfigs';

/**
 * Public SSM parameter that resolves to the AWS FIS Lambda extension layer ARN
 * for the current Region (x86_64 build — matches the default Lambda architecture).
 */
export const FIS_EXTENSION_LAYER_SSM_PARAM =
    '/aws/service/fis/lambda-extension/AWS-FIS-extension-x86_64/1.x.x';

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
 * service). Instead, the three FORWARD-path Lambdas carry the AWS FIS Lambda
 * extension layer, and FisStack injects `aws:lambda:invocation-error`
 * (preventExecution=true, 100%) — every invocation of the targeted function
 * fails immediately without the handler running, which drives the
 * Retry/Catch/compensation logic below exactly as it would for a real
 * outage, without needing to touch the state machine itself.
 *
 * An earlier version of this workspace used
 * `aws:lambda:put-function-concurrent-executions` to reach the same effect
 * by zeroing reserved concurrency. That action ID **does not exist** —
 * `aws fis list-actions` confirms Lambda-targeted FIS actions are limited to
 * the `aws:lambda:function` family (`invocation-error`,
 * `invocation-add-delay`, `invocation-http-integration-response`), the same
 * family Architecture B uses. See `lib/stacks/fis-stack.ts`.
 */
export class AppStack extends cdk.Stack {
    public readonly reserveInventoryFn: lambda.Function;
    public readonly processPaymentFn: lambda.Function;
    public readonly confirmOrderFn: lambda.Function;
    public readonly releaseInventoryFn: lambda.Function;
    public readonly refundPaymentFn: lambda.Function;
    public readonly stateMachine: sfn.StateMachine;
    /** S3 bucket used to distribute AWS FIS Lambda fault configurations. */
    public readonly fisConfigBucket: s3.IBucket;

    constructor(scope: Construct, id: string, props: AppStackProps) {
        super(scope, id, props);

        const removalPolicy = props.isAutoDeleteObject
            ? cdk.RemovalPolicy.DESTROY
            : cdk.RemovalPolicy.RETAIN;

        // --- FIS Lambda extension: config-distribution bucket ---
        // AWS FIS writes the active fault config here; the extension polls it.
        this.fisConfigBucket = new s3.Bucket(this, 'FisConfigBucket', {
            bucketName: `${props.project}-${props.environment}-f-fis-config-${this.account}`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy,
            autoDeleteObjects: props.isAutoDeleteObject,
            lifecycleRules: [{ expiration: cdk.Duration.days(1) }],
        });

        const fisExtensionLayerArn = ssm.StringParameter.valueForStringParameter(
            this,
            FIS_EXTENSION_LAYER_SSM_PARAM,
        );
        const fisConfigLocation = `arn:aws:s3:::${this.fisConfigBucket.bucketName}/${FIS_CONFIG_PREFIX}/`;
        const fisExtensionLayer = lambda.LayerVersion.fromLayerVersionArn(
            this,
            'FisExtensionLayer',
            fisExtensionLayerArn,
        );

        // --- Lambda functions ---
        // All 5 are simple mock implementations: each writes a single status
        // field to the order's DynamoDB record and returns. They exist as
        // Step Functions task targets; the 3 forward-path functions are also
        // FIS blast-radius targets and carry the FIS Lambda extension layer.

        const makeFn = (
            name: string,
            asset: string,
            description: string,
            isFisTarget: boolean,
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
                layers: isFisTarget ? [fisExtensionLayer] : undefined,
                environment: {
                    TABLE_NAME: props.table.tableName,
                    ...(isFisTarget
                        ? {
                              // AWS FIS Lambda extension wiring (see aws:lambda:invocation-* actions).
                              AWS_LAMBDA_EXEC_WRAPPER: '/opt/aws-fis/bootstrap',
                              AWS_FIS_CONFIGURATION_LOCATION: fisConfigLocation,
                              AWS_FIS_POLL_MAX_WAIT_MILLISECONDS: '2000',
                          }
                        : {}),
                },
                timeout: cdk.Duration.seconds(10),
                memorySize: 128,
                logGroup,
            });

            props.table.grantReadWriteData(fn);

            if (isFisTarget) {
                // The extension (running in the function's execution role) reads fault
                // configs from the shared bucket.
                fn.addToRolePolicy(
                    new iam.PolicyStatement({
                        sid: 'AllowListingFisConfigLocation',
                        actions: ['s3:ListBucket'],
                        resources: [this.fisConfigBucket.bucketArn],
                        conditions: { StringLike: { 's3:prefix': [`${FIS_CONFIG_PREFIX}/*`] } },
                    }),
                );
                fn.addToRolePolicy(
                    new iam.PolicyStatement({
                        sid: 'AllowReadingFisConfig',
                        actions: ['s3:GetObject'],
                        resources: [`${this.fisConfigBucket.bucketArn}/${FIS_CONFIG_PREFIX}/*`],
                    }),
                );
            }

            return fn;
        };

        this.reserveInventoryFn = makeFn(
            'ReserveInventoryFunction',
            'reserve-inventory',
            'Saga step 1 (forward): reserve inventory for the order',
            true,
        );
        this.processPaymentFn = makeFn(
            'ProcessPaymentFunction',
            'process-payment',
            'Saga step 2 (forward): process customer payment',
            true,
        );
        this.confirmOrderFn = makeFn(
            'ConfirmOrderFunction',
            'confirm-order',
            'Saga step 3 (forward, final): confirm the order',
            true,
        );
        this.releaseInventoryFn = makeFn(
            'ReleaseInventoryFunction',
            'release-inventory',
            'Saga compensation: release previously reserved inventory',
            false,
        );
        this.refundPaymentFn = makeFn(
            'RefundPaymentFunction',
            'refund-payment',
            'Saga compensation: refund a previously processed payment',
            false,
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
        new cdk.CfnOutput(this, 'FisConfigBucketName', {
            value: this.fisConfigBucket.bucketName,
            description: 'S3 bucket distributing AWS FIS Lambda fault configurations',
        });
    }
}
