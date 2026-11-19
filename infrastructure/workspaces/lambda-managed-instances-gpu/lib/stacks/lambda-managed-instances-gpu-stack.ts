import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { GpuCapacityProvider } from 'lib/constructs/gpu-capacity-provider';
import { GpuInferenceFunction } from 'lib/constructs/gpu-inference-function';

/** Objects uploaded under this prefix are classified. */
export const INPUT_PREFIX = 'input/';

/** Properties for {@link LambdaManagedInstancesGpuStack}. */
export interface LambdaManagedInstancesGpuStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Event-driven GPU batch inference on Lambda Managed Instances.
 *
 * S3 (input/) -> SQS -> GPU Event Function (G-series capacity provider) -> DynamoDB
 *
 * The capacity provider launches its instances in isolated subnets. AWS service traffic
 * (S3, DynamoDB, CloudWatch Logs) goes through VPC endpoints, so there is no NAT gateway
 * or internet gateway.
 */
export class LambdaManagedInstancesGpuStack extends cdk.Stack {
  public readonly bucket: s3.IBucket;
  public readonly queue: sqs.IQueue;
  public readonly table: dynamodb.ITable;
  public readonly gpuCapacityProvider: GpuCapacityProvider;
  public readonly inferenceFunction: GpuInferenceFunction;

  /** Creates the network, storage, queue, GPU capacity provider, function and dashboard. */
  constructor(scope: Construct, id: string, props: LambdaManagedInstancesGpuStackProps) {
    super(scope, id, props);
    const { params } = props;
    const removalPolicy = props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    // ---------------------------------------------------------------- Network
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: params.maxAzs,
      natGateways: 0,
      subnetConfiguration: [{ name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
      restrictDefaultSecurityGroup: true,
    });
    vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'FlowLogGroup', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy }),
      ),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });
    vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    vpc.addGatewayEndpoint('DynamoDbEndpoint', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });
    vpc.addInterfaceEndpoint('LogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
    });

    // Instances only open outbound connections (to the VPC endpoints); nothing connects in.
    const instanceSg = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc,
      description: 'Lambda Managed Instances GPU capacity provider instances',
      allowAllOutbound: true,
    });

    // ---------------------------------------------------------------- Storage
    const accessLogBucket = new s3.Bucket(this, 'AccessLogBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy,
      autoDeleteObjects: props.isAutoDeleteObject,
    });

    const imageBucket = new s3.Bucket(this, 'ImageBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: accessLogBucket,
      serverAccessLogsPrefix: 'image-bucket/',
      lifecycleRules: [{ prefix: INPUT_PREFIX, expiration: cdk.Duration.days(7) }],
      removalPolicy,
      autoDeleteObjects: props.isAutoDeleteObject,
    });

    this.bucket = imageBucket;

    const resultTable = new dynamodb.Table(this, 'ResultTable', {
      partitionKey: { name: 'objectKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy,
    });

    this.table = resultTable;

    // ---------------------------------------------------------------- Queue
    const dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.queue = new sqs.Queue(this, 'InferenceQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // At least 6x the function timeout, as recommended for SQS event sources
      visibilityTimeout: cdk.Duration.seconds(params.gpuFunction.timeoutSeconds * 6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: params.queue.maxReceiveCount },
    });
    this.bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.SqsDestination(this.queue), {
      prefix: INPUT_PREFIX,
    });

    // ---------------------------------------------------------------- GPU compute
    this.gpuCapacityProvider = new GpuCapacityProvider(this, 'GpuCapacityProvider', {
      subnets: vpc.isolatedSubnets,
      securityGroups: [instanceSg],
      allowedInstanceTypes: params.capacity.allowedInstanceTypes,
      maxVCpuCount: params.capacity.maxVCpuCount,
      targetGpuUtilization: params.capacity.targetGpuUtilization,
      propagatedTags: { Project: props.project, Environment: props.environment },
    });

    const functionLogGroup = new logs.LogGroup(this, 'InferenceFunctionLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });
    this.inferenceFunction = new GpuInferenceFunction(this, 'InferenceFunction', {
      ...params.gpuFunction,
      capacityProvider: this.gpuCapacityProvider,
      imageDirectory: path.join(__dirname, '../../src/inference'),
      logGroup: functionLogGroup,
      environment: {
        TABLE_NAME: this.table.tableName,
        RESULT_TTL_DAYS: '7',
      },
    });
    const fn = this.inferenceFunction.function;
    imageBucket.grants.read(fn, `${INPUT_PREFIX}*`);
    resultTable.grants.writeData(fn);

    fn.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: params.queue.batchSize,
        maxBatchingWindow: cdk.Duration.seconds(params.queue.maxBatchingWindowSeconds),
        reportBatchItemFailures: true,
      }),
    );

    // ---------------------------------------------------------------- Observability
    const dlqAlarm = new cloudwatch.Alarm(this, 'DeadLetterQueueAlarm', {
      alarmDescription: 'Images that failed inference after all retries',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const capacityMetric = (metricName: string, statistic = 'Average'): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName,
        dimensionsMap: { CapacityProviderName: this.gpuCapacityProvider.capacityProviderName },
        statistic,
        period: cdk.Duration.minutes(1),
      });

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      defaultInterval: cdk.Duration.hours(3),
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'GPU utilization (%)',
        left: [capacityMetric('GPUUtilization'), capacityMetric('GPUMemoryUtilization')],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'GPUs allocated / available',
        left: [capacityMetric('GPUAllocated', 'Maximum'), capacityMetric('GPUAvailable', 'Maximum')],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Queue backlog',
        left: [
          this.queue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
          this.queue.metricApproximateAgeOfOldestMessage({ period: cdk.Duration.minutes(1) }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Function invocations / errors / throttles',
        left: [
          fn.metricInvocations({ period: cdk.Duration.minutes(1) }),
          fn.metricErrors({ period: cdk.Duration.minutes(1) }),
          fn.metricThrottles({ period: cdk.Duration.minutes(1) }),
        ],
        width: 12,
      }),
      new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms: [dlqAlarm], width: 24, height: 3 }),
    );

    // ---------------------------------------------------------------- Outputs
    new cdk.CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    new cdk.CfnOutput(this, 'InputPrefix', { value: INPUT_PREFIX });
    new cdk.CfnOutput(this, 'ResultTableName', { value: this.table.tableName });
    new cdk.CfnOutput(this, 'QueueUrl', { value: this.queue.queueUrl });
    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', { value: dlq.queueUrl });
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'CapacityProviderName', { value: this.gpuCapacityProvider.capacityProviderName });
    new cdk.CfnOutput(this, 'DashboardName', { value: dashboard.dashboardName });
  }
}
