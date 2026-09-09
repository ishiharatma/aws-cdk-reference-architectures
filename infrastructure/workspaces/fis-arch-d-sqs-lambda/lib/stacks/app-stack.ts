import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface AppStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly table: dynamodb.ITable;
    readonly queue: sqs.IQueue;
}

/**
 * Application stack: SQS-triggered Lambda consumer + DynamoDB, plus a
 * Function-URL-fronted producer Lambda for driving demo load.
 *
 * Consumer:  SQS main queue (event source, batchSize=5) → Lambda → DynamoDB
 * Producer:  Function URL → Lambda → SQS SendMessage
 *
 * The producer exists purely so an operator can push messages into the
 * queue by hand (e.g. a shell loop of curl calls) while a D-1/D-2/D-3
 * chaos experiment throttles or disables the consumer.
 */
export class AppStack extends cdk.Stack {
    public readonly consumerFunction: lambda.Function;
    public readonly producerFunction: lambda.Function;
    public readonly producerFunctionUrl: lambda.FunctionUrl;

    constructor(scope: Construct, id: string, props: AppStackProps) {
        super(scope, id, props);

        // --- Consumer Lambda: SQS → Lambda → DynamoDB ---

        const consumerLogGroup = new logs.LogGroup(this, 'ConsumerFunctionLogGroup', {
            logGroupName: `/aws/lambda/${props.project}-${props.environment}-consumer`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        this.consumerFunction = new lambda.Function(this, 'ConsumerFunction', {
            functionName: `${props.project}-${props.environment}-consumer`,
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/consumer')),
            environment: {
                TABLE_NAME: props.table.tableName,
            },
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            logGroup: consumerLogGroup,
        });

        props.table.grantWriteData(this.consumerFunction);

        this.consumerFunction.addEventSource(
            new lambdaEventSources.SqsEventSource(props.queue, {
                batchSize: 5,
                reportBatchItemFailures: true,
            }),
        );

        // --- Producer Lambda: Function URL → Lambda → SQS SendMessage ---

        const producerLogGroup = new logs.LogGroup(this, 'ProducerFunctionLogGroup', {
            logGroupName: `/aws/lambda/${props.project}-${props.environment}-producer`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        this.producerFunction = new lambda.Function(this, 'ProducerFunction', {
            functionName: `${props.project}-${props.environment}-producer`,
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/producer')),
            environment: {
                QUEUE_URL: props.queue.queueUrl,
            },
            timeout: cdk.Duration.seconds(10),
            memorySize: 128,
            logGroup: producerLogGroup,
        });

        props.queue.grantSendMessages(this.producerFunction);

        this.producerFunctionUrl = this.producerFunction.addFunctionUrl({
            authType: lambda.FunctionUrlAuthType.AWS_IAM,
            cors: {
                allowedOrigins: ['*'],
                allowedMethods: [lambda.HttpMethod.POST, lambda.HttpMethod.GET],
            },
        });

        // --- Outputs ---

        new cdk.CfnOutput(this, 'ConsumerFunctionArn', {
            value: this.consumerFunction.functionArn,
            description: 'Consumer Lambda function ARN',
        });
        new cdk.CfnOutput(this, 'ProducerFunctionArn', {
            value: this.producerFunction.functionArn,
            description: 'Producer Lambda function ARN',
        });
        new cdk.CfnOutput(this, 'ProducerFunctionUrl', {
            value: this.producerFunctionUrl.url,
            description:
                'Producer Lambda Function URL (IAM-auth) — POST to send a demo message to SQS',
        });
    }
}
