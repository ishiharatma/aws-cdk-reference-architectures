import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface EventbridgeCustomBusStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/** Event source published by producers; every rule filters on it first. */
export const ORDER_SOURCE = 'app.orders';

/**
 * Content-based routing on a custom EventBridge event bus.
 *
 *   producers ──put-events──► orders bus ──┬─ HighValue   (OrderPlaced, amount >= threshold) ─► SQS (input transformer)
 *                                          ├─ EuOrders    (OrderPlaced, region prefix "eu-")  ─► Lambda ─► DynamoDB
 *                                          ├─ PaymentFail (PaymentFailed, reason not user_cancelled) ─► SQS
 *                                          ├─ Audit       (every app.orders event)            ─► CloudWatch Logs
 *                                          └─ Archive     (every app.orders event, replayable)
 *
 * A producer publishes facts ("an order was placed") and knows nothing about who reacts. Adding a
 * consumer is adding a rule; no producer changes.
 */
export class EventbridgeCustomBusStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EventbridgeCustomBusStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-ebus`;

    // ---------------------------------------------------------------------------------------------
    // The bus, its archive, and bus-level logging
    // ---------------------------------------------------------------------------------------------
    const bus = new events.EventBus(this, 'OrdersBus', {
      eventBusName: `${namePrefix}-orders`,
      description: 'Order lifecycle events (app.orders)',
      // Vended logs: what the bus received, matched and delivered -- the first place to look when a rule "does nothing".
      logConfig: { includeDetail: events.IncludeDetail.FULL, level: events.Level.INFO },
    });

    // `logConfig` only sets WHAT the bus logs. WHERE the logs go is a CloudWatch Logs delivery
    // (source -> destination -> delivery); without it nothing is written anywhere.
    const busLogGroup = new logs.LogGroup(this, 'BusLogGroup', {
      logGroupName: `/aws/vendedlogs/events/event-bus/${namePrefix}-orders`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });
    const logSource = new logs.CfnDeliverySource(this, 'BusLogSource', {
      name: `${namePrefix}-bus-log-source`,
      resourceArn: bus.eventBusArn,
      logType: 'INFO_LOGS',
    });
    const logDestination = new logs.CfnDeliveryDestination(this, 'BusLogDestination', {
      name: `${namePrefix}-bus-log-destination`,
      destinationResourceArn: busLogGroup.logGroupArn,
      outputFormat: 'json',
    });
    const logDelivery = new logs.CfnDelivery(this, 'BusLogDelivery', {
      deliverySourceName: logSource.name,
      deliveryDestinationArn: logDestination.attrArn,
    });
    logDelivery.addDependency(logSource);
    logDelivery.addDependency(logDestination);

    // Everything from app.orders is archived so it can be replayed into the bus later.
    bus.archive('OrdersArchive', {
      archiveName: `${namePrefix}-orders-archive`,
      description: 'All app.orders events, replayable',
      eventPattern: { source: [ORDER_SOURCE] },
      retention: cdk.Duration.days(params.archiveRetentionDays),
    });

    // ---------------------------------------------------------------------------------------------
    // Targets
    // ---------------------------------------------------------------------------------------------
    // Events EventBridge could not deliver to a target after all retries land here (not in the target).
    const targetDlq = new sqs.Queue(this, 'TargetDlq', {
      queueName: `${namePrefix}-target-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    const makeQueue = (idPrefix: string, name: string) =>
      new sqs.Queue(this, idPrefix, {
        queueName: `${namePrefix}-${name}`,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        removalPolicy,
      });
    const highValueQueue = makeQueue('HighValueQueue', 'high-value');
    const paymentQueue = makeQueue('PaymentFailedQueue', 'payment-failed');

    const processedTable = new dynamodb.Table(this, 'ProcessedTable', {
      tableName: `${namePrefix}-processed`,
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    const processor = new lambdaNodejs.NodejsFunction(this, 'ProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../src/handlers/processor.ts'),
      handler: 'handler',
      functionName: `${namePrefix}-processor`,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: { TABLE_NAME: processedTable.tableName },
      logGroup: new logs.LogGroup(this, 'ProcessorLogGroup', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy }),
    });
    processedTable.grant(processor, 'dynamodb:PutItem');

    const auditLogGroup = new logs.LogGroup(this, 'AuditLogGroup', {
      logGroupName: `/${namePrefix}/audit`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    // Delivery policy shared by targets: bounded retries, bounded age, then the DLQ.
    const delivery = {
      deadLetterQueue: targetDlq,
      retryAttempts: params.targetRetryAttempts,
      maxEventAge: cdk.Duration.minutes(params.targetMaxEventAgeMinutes),
    };

    // ---------------------------------------------------------------------------------------------
    // Rules (event patterns: exact match, numeric, prefix, anything-but)
    // ---------------------------------------------------------------------------------------------
    // 1. Numeric filter + input transformer: the consumer gets a small purpose-built message, not the envelope.
    new events.Rule(this, 'HighValueRule', {
      ruleName: `${namePrefix}-high-value`,
      description: `OrderPlaced with amount >= ${params.highValueThreshold}`,
      eventBus: bus,
      eventPattern: {
        source: [ORDER_SOURCE],
        detailType: ['OrderPlaced'],
        detail: { amount: [{ numeric: ['>=', params.highValueThreshold] }] },
      },
      targets: [
        new targets.SqsQueue(highValueQueue, {
          ...delivery,
          message: events.RuleTargetInput.fromObject({
            orderId: events.EventField.fromPath('$.detail.orderId'),
            amount: events.EventField.fromPath('$.detail.amount'),
            region: events.EventField.fromPath('$.detail.region'),
            tier: 'high-value',
          }),
        }),
      ],
    });

    // 2. Prefix filter -> Lambda.
    new events.Rule(this, 'EuOrdersRule', {
      ruleName: `${namePrefix}-eu-orders`,
      description: 'OrderPlaced from a region starting with "eu-"',
      eventBus: bus,
      eventPattern: {
        source: [ORDER_SOURCE],
        detailType: ['OrderPlaced'],
        detail: { region: [{ prefix: 'eu-' }] },
      },
      targets: [new targets.LambdaFunction(processor, delivery)],
    });

    // 3. anything-but: alert on payment failures except the ones the customer caused themselves.
    new events.Rule(this, 'PaymentFailedRule', {
      ruleName: `${namePrefix}-payment-failed`,
      description: 'PaymentFailed unless the customer cancelled',
      eventBus: bus,
      eventPattern: {
        source: [ORDER_SOURCE],
        detailType: ['PaymentFailed'],
        detail: { reason: [{ 'anything-but': ['user_cancelled'] }] },
      },
      targets: [new targets.SqsQueue(paymentQueue, delivery)],
    });

    // 4. Catch-all for the source: audit trail written by EventBridge itself (no Lambda in the path).
    new events.Rule(this, 'AuditRule', {
      ruleName: `${namePrefix}-audit`,
      description: 'Every app.orders event to CloudWatch Logs',
      eventBus: bus,
      eventPattern: { source: [ORDER_SOURCE] },
      targets: [new targets.CloudWatchLogGroup(auditLogGroup, { deadLetterQueue: targetDlq, retryAttempts: params.targetRetryAttempts })],
    });

    // ---------------------------------------------------------------------------------------------
    // Alarm: anything in the DLQ means a target could not be reached
    // ---------------------------------------------------------------------------------------------
    new cloudwatch.Alarm(this, 'TargetDlqAlarm', {
      alarmName: `${namePrefix}-target-dlq-not-empty`,
      alarmDescription: 'EventBridge could not deliver an event to a target after all retries.',
      metric: targetDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ---------------------------------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'EventBusName', { value: bus.eventBusName });
    new cdk.CfnOutput(this, 'ArchiveName', { value: `${namePrefix}-orders-archive` });
    new cdk.CfnOutput(this, 'HighValueQueueUrl', { value: highValueQueue.queueUrl });
    new cdk.CfnOutput(this, 'PaymentFailedQueueUrl', { value: paymentQueue.queueUrl });
    new cdk.CfnOutput(this, 'TargetDlqUrl', { value: targetDlq.queueUrl });
    new cdk.CfnOutput(this, 'ProcessedTableName', { value: processedTable.tableName });
    new cdk.CfnOutput(this, 'BusLogGroupName', { value: busLogGroup.logGroupName });
    new cdk.CfnOutput(this, 'AuditLogGroupName', { value: auditLogGroup.logGroupName });
  }
}
