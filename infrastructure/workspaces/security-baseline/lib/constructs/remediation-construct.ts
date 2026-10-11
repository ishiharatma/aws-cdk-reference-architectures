import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { RemediationParams } from 'parameters/environments';

/** Properties for {@link RemediationConstruct}. */
export interface RemediationConstructProps {
  /** Prefix for resource names. */
  readonly namePrefix: string;
  /** Settings of the automatic remediation. */
  readonly params: RemediationParams;
  /** Topic that receives one message per remediation outcome (the findings topic). */
  readonly topic: sns.ITopic;
  /** Delete log groups and the DLQ on stack deletion (non-production only). */
  readonly isAutoDeleteObject: boolean;
}

const SEVERITY_ORDER = ['MEDIUM', 'HIGH', 'CRITICAL'] as const;

/**
 * Automatic remediation of Security Hub findings, in two EventBridge rules and one Lambda function.
 *
 *   control finding (S3 public access, SSH/RDP open to the internet) ──► block public access / revoke the rule
 *   GuardDuty finding on an EC2 instance at or above the severity ──► swap its security groups for an empty one
 *
 * `mode: dry-run` records what would be done and changes nothing, which is the safe first step in a real account.
 * The function writes its outcome to the finding as a note (and resolves it when it acted) and to the findings topic.
 */
export class RemediationConstruct extends Construct {
  /** The remediation function. */
  public readonly function: lambda.IFunction;
  /** Events EventBridge could not deliver to the function after all retries. */
  public readonly dlq: sqs.IQueue;

  /**
   * Creates the function, its least-privilege role, the DLQ and both rules.
   *
   * @param scope - parent construct
   * @param id - construct ID
   * @param props - remediation settings
   */
  constructor(scope: Construct, id: string, props: RemediationConstructProps) {
    super(scope, id);

    const { namePrefix, params, topic, isAutoDeleteObject } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const stack = cdk.Stack.of(this);

    // `Default` is the product of findings imported with BatchImportFindings. Trusting it is a test hook that lets
    // the check script exercise the rules with real resources; it stays off outside development.
    const productNames = (base: string) => (params.acceptImportedFindings ? [base, 'Default'] : [base]);

    const fn = new lambdaNodejs.NodejsFunction(this, 'Function', {
      functionName: `${namePrefix}-remediation`,
      description: 'Remediates Security Hub findings: S3 public access, open SSH/RDP, compromised EC2 instances',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../src/remediation/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      reservedConcurrentExecutions: params.reservedConcurrency, // caps a burst of findings; see the parameter for the quota trap
      environment: {
        MODE: params.mode,
        S3_CONTROL_IDS: params.s3ControlIds.join(','),
        SG_CONTROL_IDS: params.sgControlIds.join(','),
        REMOTE_ADMIN_PORTS: params.remoteAdminPorts.join(','),
        GUARDDUTY_MIN_SEVERITY: params.guardDutyMinSeverity,
        TRUSTED_PRODUCTS: [...productNames('Security Hub'), ...productNames('GuardDuty')].join(','),
        SKIP_TAG_KEY: params.skipTagKey,
        NAME_PREFIX: namePrefix,
        TOPIC_ARN: topic.topicArn,
      },
      logGroup: new logs.LogGroup(this, 'LogGroup', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy }),
    });

    // The actions are scoped to the API calls they need. EC2 and S3 resources are chosen by the finding at run time,
    // so the resource cannot be narrowed further; the skip tag and dry-run mode are the safeguards.
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadAndFixSecurityGroupsAndInstances',
      actions: [
        'ec2:DescribeInstances', 'ec2:DescribeSecurityGroups',
        'ec2:RevokeSecurityGroupIngress', 'ec2:RevokeSecurityGroupEgress',
        'ec2:CreateSecurityGroup', 'ec2:CreateTags', 'ec2:ModifyInstanceAttribute',
      ],
      resources: ['*'],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'BlockPublicAccessOnBuckets',
      actions: ['s3:PutBucketPublicAccessBlock', 's3:GetBucketTagging'],
      resources: ['arn:aws:s3:::*'],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RecordOutcomeOnFindings',
      actions: ['securityhub:BatchUpdateFindings'],
      resources: ['*'],
    }));
    topic.grantPublish(fn);

    const dlq = new sqs.Queue(this, 'Dlq', {
      queueName: `${namePrefix}-remediation-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });
    const target = new targets.LambdaFunction(fn, { deadLetterQueue: dlq, retryAttempts: 2, maxEventAge: cdk.Duration.minutes(30) });

    new events.Rule(this, 'ControlFindingsRule', {
      ruleName: `${namePrefix}-remediate-controls`,
      description: 'Failed Security Hub controls that have an automatic remediation',
      eventPattern: {
        source: ['aws.securityhub'],
        detailType: ['Security Hub Findings - Imported'],
        detail: {
          findings: {
            ProductName: productNames('Security Hub'),
            RecordState: ['ACTIVE'],
            Workflow: { Status: ['NEW'] },
            Compliance: { Status: ['FAILED'], SecurityControlId: [...params.s3ControlIds, ...params.sgControlIds] },
          },
        },
      },
      targets: [target],
    });

    const minIndex = SEVERITY_ORDER.indexOf(params.guardDutyMinSeverity);
    new events.Rule(this, 'ThreatFindingsRule', {
      ruleName: `${namePrefix}-remediate-threats`,
      description: `GuardDuty findings on EC2 instances at or above ${params.guardDutyMinSeverity}`,
      eventPattern: {
        source: ['aws.securityhub'],
        detailType: ['Security Hub Findings - Imported'],
        detail: {
          findings: {
            ProductName: productNames('GuardDuty'),
            RecordState: ['ACTIVE'],
            Workflow: { Status: ['NEW'] },
            Severity: { Label: SEVERITY_ORDER.slice(minIndex) as unknown as string[] },
            Resources: { Type: ['AwsEc2Instance'] },
          },
        },
      },
      targets: [target],
    });

    new cdk.CfnOutput(stack, 'RemediationFunctionName', { value: fn.functionName });
    new cdk.CfnOutput(stack, 'RemediationMode', { value: params.mode });

    this.function = fn;
    this.dlq = dlq;
  }
}
