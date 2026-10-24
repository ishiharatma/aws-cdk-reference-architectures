import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as scheduler_targets from 'aws-cdk-lib/aws-scheduler-targets';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface AwsEnvironmentReportApplicationStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
  readonly bucket: s3.IBucket;
  readonly key: kms.IKey;
  readonly webhookSecret: secretsmanager.ISecret;
}

/** Collector name -> Lambda entry directory under src/lambda. */
const COLLECTORS = ['config', 'resource-explorer', 'cost', 'security'] as const;

/**
 * Stateless stack: the monthly pipeline.
 *
 * EventBridge Scheduler (daily, days 3-10)
 *   -> Step Functions (Standard)
 *        1. Preflight       - target month, "already built?", "CUR finalized?"
 *        2. ShouldRun       - SKIP ends the execution (try again tomorrow)
 *        3. Collect         - Parallel: config / resource-explorer / cost /
 *                             security. Each branch catches its own failure,
 *                             so one broken source never stops the report.
 *                             Collectors write raw/YYYY-MM/<source>.json and
 *                             return only a small status object.
 *        4. BuildReport     - Python container: diagram (draw.io SVG + PNG),
 *                             cost and security overlays, HTML, Bedrock summary,
 *                             manifest.json last
 *        5. Notify          - Slack / Teams webhooks from Secrets Manager
 *
 * All collector permissions are read-only and limited to the APIs each one
 * calls; the AI step only reads the collected data and never gets AWS API
 * access of its own.
 */
export class AwsEnvironmentReportApplicationStack extends cdk.Stack {
  public readonly stateMachine: sfn.IStateMachine;

  constructor(scope: Construct, id: string, props: AwsEnvironmentReportApplicationStackProps) {
    super(scope, id, props);

    const { target, schedule, cur, security, summary } = props.params;
    const namePrefix = `${props.project}-${props.environment}`;
    const logRemovalPolicy = props.isAutoDeleteObject
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.RETAIN;

    const commonEnvironment: Record<string, string> = {
      BUCKET_NAME: props.bucket.bucketName,
      TARGET_REGIONS: target.regions.join(','),
      TIME_ZONE: schedule.scheduleTimeZone.timezoneName,
      FINALIZE_DEADLINE_DAY: String(schedule.finalizeDeadlineDay),
      CUR_BUCKET: cur?.bucketName ?? '',
      CUR_PREFIX: cur?.prefix ?? '',
      CUR_EXPORT_NAME: cur?.exportName ?? '',
      MAX_FINDINGS_PER_SOURCE: String(security.maxFindingsPerSource),
    };

    const nodeFunction = (
      name: string,
      entryDir: string,
      timeout: cdk.Duration,
      memorySize: number
    ) =>
      new lambdaNodejs.NodejsFunction(this, `${name}Function`, {
        functionName: `${namePrefix}-envreport-${entryDir}`,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'handler',
        entry: path.join(__dirname, `../../src/lambda/${entryDir}/index.ts`),
        timeout,
        memorySize,
        environment: commonEnvironment,
        bundling: { externalModules: [], minify: true, sourceMap: true, target: 'node22' },
        logGroup: new logs.LogGroup(this, `${name}LogGroup`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: logRemovalPolicy,
        }),
      });

    // -----------------------------------------------------------------------
    // Preflight
    // -----------------------------------------------------------------------
    const preflightFunction = nodeFunction('Preflight', 'preflight', cdk.Duration.minutes(2), 1024);
    props.bucket.grantRead(preflightFunction, 'reports/*');

    // -----------------------------------------------------------------------
    // Collectors
    // -----------------------------------------------------------------------
    const collectorFunctions = Object.fromEntries(
      COLLECTORS.map((name) => {
        const fn = nodeFunction(
          `Collect${name.replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase())}`,
          `collect-${name}`,
          cdk.Duration.minutes(15),
          name === 'cost' ? 2048 : 1024
        );
        props.bucket.grantWrite(fn, 'raw/*');
        return [name, fn];
      })
    ) as Record<(typeof COLLECTORS)[number], lambdaNodejs.NodejsFunction>;

    collectorFunctions.config.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'config:DescribeConfigurationRecorders',
          'config:DescribeConfigurationRecorderStatus',
          'config:SelectResourceConfig',
        ],
        resources: ['*'],
      })
    );
    collectorFunctions['resource-explorer'].addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'resource-explorer-2:GetIndex',
          'resource-explorer-2:GetDefaultView',
          'resource-explorer-2:ListResources',
        ],
        resources: ['*'],
      })
    );
    collectorFunctions.security.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'securityhub:DescribeHub',
          'securityhub:GetFindings',
          'guardduty:ListDetectors',
          'guardduty:GetDetector',
          'guardduty:ListFindings',
          'guardduty:GetFindings',
          'access-analyzer:ListAnalyzers',
          'access-analyzer:ListFindings',
          'inspector2:BatchGetAccountStatus',
          'inspector2:ListFindings',
        ],
        resources: ['*'],
      })
    );

    if (cur) {
      // Read-only access to the export's own prefix in the CUR bucket.
      const curPrefix = `${cur.prefix}/${cur.exportName}/`;
      const curBucket = s3.Bucket.fromBucketName(this, 'CurBucket', cur.bucketName);
      for (const fn of [preflightFunction, collectorFunctions.cost]) {
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['s3:ListBucket'],
            resources: [curBucket.bucketArn],
            conditions: { StringLike: { 's3:prefix': [`${curPrefix}*`] } },
          })
        );
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [curBucket.arnForObjects(`${curPrefix}*`)],
          })
        );
      }
    }

    // -----------------------------------------------------------------------
    // BuildReport (Python container: cairosvg needs the native cairo library)
    // -----------------------------------------------------------------------
    const buildReportFunction = new lambda.DockerImageFunction(this, 'BuildReportFunction', {
      functionName: `${namePrefix}-envreport-build-report`,
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../src/report-builder'),
        {
          platform: ecrAssets.Platform.LINUX_AMD64,
        }
      ),
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.minutes(10),
      memorySize: 2048,
      environment: {
        BUCKET_NAME: props.bucket.bucketName,
        TIME_ZONE: schedule.scheduleTimeZone.timezoneName,
        SUMMARY_ENABLED: String(summary.enabled),
        BEDROCK_MODEL_ID: summary.bedrockModelId,
        LOCALE: summary.locale,
      },
      logGroup: new logs.LogGroup(this, 'BuildReportLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: logRemovalPolicy,
      }),
    });
    props.bucket.grantRead(buildReportFunction);
    props.bucket.grantWrite(buildReportFunction, 'reports/*');
    if (summary.enabled) {
      // Cross-region inference profiles route to foundation models in other
      // Regions (or an empty Region for global.*), so the foundation-model
      // Region is wildcarded; the inference profile stays in this Region.
      buildReportFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: [
            `arn:${cdk.Aws.PARTITION}:bedrock:*::foundation-model/*`,
            `arn:${cdk.Aws.PARTITION}:bedrock:${this.region}:${this.account}:inference-profile/*`,
          ],
        })
      );
    }

    // -----------------------------------------------------------------------
    // Notify
    // -----------------------------------------------------------------------
    const notifyFunction = nodeFunction('Notify', 'notify', cdk.Duration.minutes(1), 256);
    notifyFunction.addEnvironment('WEBHOOK_SECRET_ARN', props.webhookSecret.secretArn);
    // Not webhookSecret.grantRead(): for a KMS-encrypted secret it adds this
    // stack's role to the Data stack's key policy, a cross-stack cycle. The
    // key policy already delegates to IAM, so identity policies suffice.
    notifyFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [props.webhookSecret.secretArn],
      })
    );
    notifyFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [props.key.keyArn],
        conditions: {
          StringEquals: { 'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com` },
        },
      })
    );

    // -----------------------------------------------------------------------
    // State machine
    // -----------------------------------------------------------------------
    const preflightTask = new tasks.LambdaInvoke(this, 'Preflight', {
      lambdaFunction: preflightFunction,
      payload: sfn.TaskInput.fromObject({ 'input.$': '$' }),
      outputPath: '$.Payload',
    });

    const collect = new sfn.Parallel(this, 'Collect', { resultPath: '$.collectors' });
    for (const name of COLLECTORS) {
      const task = new tasks.LambdaInvoke(this, `Collect ${name}`, {
        lambdaFunction: collectorFunctions[name],
        payload: sfn.TaskInput.fromObject({ 'targetMonth.$': '$.targetMonth' }),
        outputPath: '$.Payload',
        retryOnServiceExceptions: true,
      });
      // A failed collector becomes an ERROR status instead of failing the run.
      // Flat object (no path inside an array): BuildReport accepts both shapes.
      task.addCatch(
        new sfn.Pass(this, `Collect ${name} failed`, {
          parameters: { collector: name, source: name, status: 'ERROR', 'message.$': '$.Error' },
        })
      );
      collect.branch(task);
    }

    const buildReportTask = new tasks.LambdaInvoke(this, 'BuildReport', {
      lambdaFunction: buildReportFunction,
      outputPath: '$.Payload',
    });

    const notifyTask = new tasks.LambdaInvoke(this, 'Notify', {
      lambdaFunction: notifyFunction,
      outputPath: '$.Payload',
    });

    const definition = preflightTask.next(
      new sfn.Choice(this, 'ShouldRun')
        .when(
          sfn.Condition.stringEquals('$.action', 'RUN'),
          collect.next(buildReportTask).next(notifyTask)
        )
        .otherwise(new sfn.Succeed(this, 'Skipped'))
    );

    const stateMachineLogGroup = new logs.LogGroup(this, 'StateMachineLogGroup', {
      logGroupName: `/aws/vendedlogs/states/${namePrefix}-environment-report`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: logRemovalPolicy,
    });

    const stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: `${namePrefix}-environment-report`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.hours(1),
      tracingEnabled: true,
      logs: {
        destination: stateMachineLogGroup,
        // Execution data stays out of the logs: it carries finding counts and
        // cost totals that belong in the encrypted bucket, not in CloudWatch.
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
    });
    this.stateMachine = stateMachine;

    // -----------------------------------------------------------------------
    // Schedule
    // -----------------------------------------------------------------------
    new scheduler.Schedule(this, 'DailySchedule', {
      scheduleName: `${namePrefix}-environment-report`,
      description:
        'Daily in the month-start window; the state machine builds the report once CUR is finalized',
      schedule: scheduler.ScheduleExpression.expression(
        schedule.scheduleExpression,
        schedule.scheduleTimeZone
      ),
      target: new scheduler_targets.StepFunctionsStartExecution(stateMachine, {
        input: scheduler.ScheduleTargetInput.fromObject({}),
      }),
    });

    new cdk.CfnOutput(this, 'StateMachineArn', { value: stateMachine.stateMachineArn });
  }
}
