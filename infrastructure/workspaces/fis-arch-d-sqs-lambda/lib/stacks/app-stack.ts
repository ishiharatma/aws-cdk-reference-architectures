import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
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
 * chaos experiment degrades the consumer.
 *
 * The consumer carries the AWS FIS Lambda extension layer so that FisStack
 * can inject invocation faults (error / added latency) without any change to
 * the function code — see `lib/stacks/fis-stack.ts` for why this replaced an
 * earlier design based on `aws:lambda:put-function-concurrent-executions`
 * (that action does not exist). FIS and the extension exchange the active
 * fault configuration through `fisConfigBucket`.
 */
export class AppStack extends cdk.Stack {
    public readonly consumerFunction: lambda.Function;
    public readonly producerFunction: lambda.Function;
    public readonly producerFunctionUrl: lambda.FunctionUrl;
    /** S3 bucket used to distribute AWS FIS Lambda fault configurations. */
    public readonly fisConfigBucket: s3.IBucket;

    constructor(scope: Construct, id: string, props: AppStackProps) {
        super(scope, id, props);

        // --- FIS Lambda extension: config-distribution bucket ---
        // AWS FIS writes the active fault config here; the extension polls it.
        this.fisConfigBucket = new s3.Bucket(this, 'FisConfigBucket', {
            bucketName: `${props.project}-${props.environment}-d-fis-config-${this.account}`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
            autoDeleteObjects: props.isAutoDeleteObject,
            lifecycleRules: [{ expiration: cdk.Duration.days(1) }],
        });

        // --- Consumer Lambda: SQS → Lambda → DynamoDB ---

        const consumerLogGroup = new logs.LogGroup(this, 'ConsumerFunctionLogGroup', {
            logGroupName: `/aws/lambda/${props.project}-${props.environment}-consumer`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        const fisExtensionLayerArn = ssm.StringParameter.valueForStringParameter(
            this,
            FIS_EXTENSION_LAYER_SSM_PARAM,
        );
        const fisConfigLocation = `arn:aws:s3:::${this.fisConfigBucket.bucketName}/${FIS_CONFIG_PREFIX}/`;

        this.consumerFunction = new lambda.Function(this, 'ConsumerFunction', {
            functionName: `${props.project}-${props.environment}-consumer`,
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/consumer')),
            layers: [
                lambda.LayerVersion.fromLayerVersionArn(
                    this,
                    'FisExtensionLayer',
                    fisExtensionLayerArn,
                ),
            ],
            environment: {
                TABLE_NAME: props.table.tableName,
                // AWS FIS Lambda extension wiring (see aws:lambda:invocation-* actions).
                AWS_LAMBDA_EXEC_WRAPPER: '/opt/aws-fis/bootstrap',
                AWS_FIS_CONFIGURATION_LOCATION: fisConfigLocation,
                // Give the extension time to fetch fault config before deciding
                // whether to block execution (recommended when preventExecution=true).
                AWS_FIS_POLL_MAX_WAIT_MILLISECONDS: '2000',
            },
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            logGroup: consumerLogGroup,
        });

        props.table.grantWriteData(this.consumerFunction);

        // The extension (running in the function's execution role) reads fault
        // configs from the shared bucket.
        this.consumerFunction.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'AllowListingFisConfigLocation',
                actions: ['s3:ListBucket'],
                resources: [this.fisConfigBucket.bucketArn],
                conditions: { StringLike: { 's3:prefix': [`${FIS_CONFIG_PREFIX}/*`] } },
            }),
        );
        this.consumerFunction.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'AllowReadingFisConfig',
                actions: ['s3:GetObject'],
                resources: [`${this.fisConfigBucket.bucketArn}/${FIS_CONFIG_PREFIX}/*`],
            }),
        );

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
        new cdk.CfnOutput(this, 'FisConfigBucketName', {
            value: this.fisConfigBucket.bucketName,
            description: 'S3 bucket distributing AWS FIS Lambda fault configurations',
        });
    }
}
