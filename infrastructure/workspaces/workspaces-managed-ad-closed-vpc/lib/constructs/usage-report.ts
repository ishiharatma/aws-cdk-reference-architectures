import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { UsageReportParams } from 'lib/types';

/** Properties of {@link UsageReport}. */
export interface UsageReportProps {
  readonly namePrefix: string;
  readonly params: UsageReportParams;
  readonly removalPolicy: cdk.RemovalPolicy;
  readonly autoDeleteObjects: boolean;
}

/**
 * Monthly usage report (requirement 6).
 *
 * EventBridge Scheduler -> Lambda (Python) -> CSV in S3 + summary via SNS.
 * The Lambda function runs outside the closed VPC: it only calls the WorkSpaces, S3 and SNS
 * APIs, so placing it in the VPC would only add endpoints (workspaces, sns) for no benefit.
 */
export class UsageReport extends Construct {
  public readonly bucket: s3.IBucket;
  public readonly topic: sns.ITopic;
  public readonly function: lambda.IFunction;

  /**

   * Define the resources.

   *
   * @param scope - Parent construct
   * @param id - Construct ID
   * @param props - Construct properties
   */
  constructor(scope: Construct, id: string, props: UsageReportProps) {
    super(scope, id);

    const { params } = props;

    // ------------------------------------------------------------------
    // S3: CSV archive
    // ------------------------------------------------------------------
    const accessLogBucket = new s3.Bucket(this, 'AccessLogBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: cdk.Duration.days(params.reportRetentionDays) }],
      removalPolicy: props.removalPolicy,
      autoDeleteObjects: props.autoDeleteObjects,
    });

    const bucket = new s3.Bucket(this, 'ReportBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: accessLogBucket,
      serverAccessLogsPrefix: 'report-bucket/',
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(params.reportRetentionDays),
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
      removalPolicy: props.removalPolicy,
      autoDeleteObjects: props.autoDeleteObjects,
    });

    // ------------------------------------------------------------------
    // SNS: summary notification (encrypted with the AWS managed SNS key)
    // ------------------------------------------------------------------
    const topic = new sns.Topic(this, 'ReportTopic', {
      topicName: `${props.namePrefix}-workspaces-usage-report`,
      displayName: 'WorkSpaces usage report',
      enforceSSL: true,
      masterKey: kms.Alias.fromAliasName(this, 'SnsManagedKey', 'alias/aws/sns'),
    });
    for (const email of params.notificationEmails) {
      topic.addSubscription(new subscriptions.EmailSubscription(email));
    }

    // ------------------------------------------------------------------
    // Lambda (Python)
    // ------------------------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'FunctionLogGroup', {
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: props.removalPolicy,
    });

    const fn = new lambda.Function(this, 'Function', {
      functionName: `${props.namePrefix}-workspaces-usage-report`,
      description: 'Monthly WorkSpaces last-connection report (CSV to S3, summary to SNS)',
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../src/lambda/usage_report'), {
        exclude: ['test_*.py', '__pycache__'],
      }),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      logGroup,
      environment: {
        REPORT_BUCKET: bucket.bucketName,
        REPORT_PREFIX: 'reports',
        TOPIC_ARN: topic.topicArn,
        INACTIVE_THRESHOLD_DAYS: String(params.inactiveThresholdDays),
        REPORT_TIME_ZONE: params.timeZone.timezoneName,
      },
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        // Neither API supports resource-level permissions.
        actions: ['workspaces:DescribeWorkspaces', 'workspaces:DescribeWorkspacesConnectionStatus'],
        resources: ['*'],
      })
    );
    bucket.grants.put(fn, 'reports/*');
    topic.grants.publish(fn);

    // ------------------------------------------------------------------
    // EventBridge Scheduler: monthly
    // ------------------------------------------------------------------
    new scheduler.Schedule(this, 'Schedule', {
      scheduleName: `${props.namePrefix}-workspaces-usage-report`,
      description: 'Monthly WorkSpaces usage report',
      schedule: scheduler.ScheduleExpression.expression(params.scheduleExpression, params.timeZone),
      target: new schedulerTargets.LambdaInvoke(fn, { retryAttempts: 2 }),
    });

    this.bucket = bucket;
    this.topic = topic;
    this.function = fn;
  }
}
