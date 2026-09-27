import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as scheduler_targets from 'aws-cdk-lib/aws-scheduler-targets';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface AwsEolMonitorApplicationStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
  readonly table: dynamodb.ITable;
}

/**
 * Stateless stack: the periodic check itself.
 *
 * EventBridge Scheduler (cron)
 *   -> Step Functions (Standard, JSONPath)
 *        1. FetchEolDiff   - Lambda: pulls awslabs/aws-service-eol-data's
 *           eol.json, diffs it against the DynamoDB state table (Data
 *           stack), and writes the new state back.
 *        2. HasDiff        - Choice: skip straight to End if nothing changed.
 *        3. GenerateReport - Lambda: sends the diff list to Bedrock and gets
 *           back a prioritized Japanese/English Markdown digest.
 *        4. PublishReport  - Step Functions' native SNS integration publishes
 *           the digest.
 *   -> SNS Topic -> email (add a Chatbot/Slack subscription the same way the
 *      budgets-cost-anomaly-detection workspace does, if needed)
 */
export class AwsEolMonitorApplicationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AwsEolMonitorApplicationStackProps) {
    super(scope, id, props);

    const { collector, report, schedule, notification } = props.params;
    const namePrefix = `${props.project}-${props.environment}`;

    // -----------------------------------------------------------------------
    // SNS: digest destination
    // -----------------------------------------------------------------------
    const topic = new sns.Topic(this, 'ReportTopic', {
      topicName: `${namePrefix}-eol-report`,
      displayName: 'AWS Service EOL Monitor',
    });
    for (const email of notification.emails) {
      topic.addSubscription(new subscriptions.EmailSubscription(email));
    }

    // -----------------------------------------------------------------------
    // Lambda: FetchEolDiff
    // -----------------------------------------------------------------------
    const commonBundling: lambdaNodejs.BundlingOptions = {
      externalModules: [],
      minify: true,
      sourceMap: true,
      target: 'node22',
    };

    const fetchDiffFunction = new lambdaNodejs.NodejsFunction(this, 'FetchEolDiffFunction', {
      functionName: `${namePrefix}-fetch-eol-diff`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler',
      entry: path.join(__dirname, '../../src/lambda/fetch-eol-diff/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        TABLE_NAME: props.table.tableName,
        DATASET_URL: collector.datasetUrl,
        UPCOMING_THRESHOLD_DAYS: String(collector.upcomingThresholdDays),
      },
      bundling: commonBundling,
      logGroup: new logs.LogGroup(this, 'FetchEolDiffLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      }),
    });
    props.table.grantReadWriteData(fetchDiffFunction);

    // -----------------------------------------------------------------------
    // Lambda: GenerateReport (Bedrock)
    // -----------------------------------------------------------------------
    const generateReportFunction = new lambdaNodejs.NodejsFunction(this, 'GenerateReportFunction', {
      functionName: `${namePrefix}-generate-eol-report`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler',
      entry: path.join(__dirname, '../../src/lambda/generate-report/index.ts'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        BEDROCK_MODEL_ID: report.bedrockModelId,
        LOCALE: report.locale,
      },
      bundling: commonBundling,
      logGroup: new logs.LogGroup(this, 'GenerateReportLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      }),
    });

    // Cross-region inference profiles invoke the underlying foundation model
    // in multiple Regions, so both ARN shapes need to be grantable.
    generateReportFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:bedrock:*::foundation-model/*`,
          `arn:${cdk.Aws.PARTITION}:bedrock:${this.region}:${this.account}:inference-profile/*`,
        ],
      }),
    );

    // -----------------------------------------------------------------------
    // Step Functions: FetchEolDiff -> Choice -> GenerateReport -> PublishReport
    // -----------------------------------------------------------------------
    const fetchDiffTask = new tasks.LambdaInvoke(this, 'FetchEolDiff', {
      lambdaFunction: fetchDiffFunction,
      outputPath: '$.Payload',
    });

    const generateReportTask = new tasks.LambdaInvoke(this, 'GenerateReport', {
      lambdaFunction: generateReportFunction,
      outputPath: '$.Payload',
    });

    const publishReportTask = new tasks.SnsPublish(this, 'PublishReport', {
      topic,
      subject: sfn.JsonPath.stringAt('$.subject'),
      message: sfn.TaskInput.fromJsonPathAt('$.body'),
    });

    const noChangesDetected = new sfn.Pass(this, 'NoChangesDetected');

    const definition = fetchDiffTask.next(
      new sfn.Choice(this, 'HasDiff')
        .when(sfn.Condition.numberGreaterThan('$.diffCount', 0), generateReportTask.next(publishReportTask))
        .otherwise(noChangesDetected),
    );

    const stateMachineLogGroup = new logs.LogGroup(this, 'StateMachineLogGroup', {
      logGroupName: `/aws/vendedlogs/states/${namePrefix}-eol-monitor`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });

    const stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: `${namePrefix}-eol-monitor`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      tracingEnabled: true,
      logs: {
        destination: stateMachineLogGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });
    topic.grantPublish(stateMachine.role);

    // -----------------------------------------------------------------------
    // EventBridge Scheduler: triggers the state machine on a cron schedule
    // -----------------------------------------------------------------------
    new scheduler.Schedule(this, 'CheckSchedule', {
      scheduleName: `${namePrefix}-eol-check`,
      description: 'Periodically checks awslabs/aws-service-eol-data for changes and reports via Bedrock+SNS',
      schedule: scheduler.ScheduleExpression.expression(schedule.scheduleExpression, schedule.scheduleTimeZone),
      target: new scheduler_targets.StepFunctionsStartExecution(stateMachine, {}),
    });
  }
}
