import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface BaseStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
}

/**
 * Base infrastructure stack: DynamoDB table + SQS main queue + DLQ.
 *
 * The table uses PAY_PER_REQUEST billing so it scales to zero cost between
 * chaos experiments. The main queue redrives to the DLQ after
 * `maxReceiveCount` failed/unprocessed receives — this is what makes FIS
 * scenario D-2 (a 20-minute consumer outage) reliably push messages to the
 * DLQ: visibilityTimeout (60s) x maxReceiveCount (3) = 180s, far shorter
 * than the 20-minute outage.
 */
export class BaseStack extends cdk.Stack {
    public readonly table: dynamodb.Table;
    public readonly deadLetterQueue: sqs.Queue;
    public readonly queue: sqs.Queue;

    constructor(scope: Construct, id: string, props: BaseStackProps) {
        super(scope, id, props);

        this.table = new dynamodb.Table(this, 'ProcessedRecordsTable', {
            tableName: `${props.project}-${props.environment}-processed-records`,
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
        });

        // --- SQS Dead Letter Queue ---
        // Messages the consumer fails to process 3 times land here for later inspection/replay.

        this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
            queueName: `${props.project}-${props.environment}-dlq`,
            retentionPeriod: cdk.Duration.days(14),
            enforceSSL: true,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        // --- SQS Main Queue ---
        // visibilityTimeout=60s gives the consumer a full minute per receive before a
        // message becomes visible again; maxReceiveCount=3 on the redrive policy means a
        // message that fails (or goes unprocessed because the consumer is disabled) 3
        // times moves to the DLQ instead of looping forever.

        this.queue = new sqs.Queue(this, 'MainQueue', {
            queueName: `${props.project}-${props.environment}-main-queue`,
            visibilityTimeout: cdk.Duration.seconds(60),
            retentionPeriod: cdk.Duration.days(4),
            enforceSSL: true,
            deadLetterQueue: {
                queue: this.deadLetterQueue,
                maxReceiveCount: 3,
            },
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        // --- Outputs ---

        new cdk.CfnOutput(this, 'TableName', {
            value: this.table.tableName,
            description: 'DynamoDB processed-records table name',
        });
        new cdk.CfnOutput(this, 'QueueUrl', {
            value: this.queue.queueUrl,
            description: 'SQS main queue URL',
        });
        new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
            value: this.deadLetterQueue.queueUrl,
            description: 'SQS dead-letter queue URL',
        });
    }
}
