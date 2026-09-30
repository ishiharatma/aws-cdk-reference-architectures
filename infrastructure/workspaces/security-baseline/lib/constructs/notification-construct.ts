import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/** Properties for {@link NotificationConstruct}. */
export interface NotificationConstructProps {
  /** Prefix for resource names. */
  readonly namePrefix: string;
  /** Customer managed key that encrypts the topic (its key policy is extended for EventBridge). */
  readonly key: kms.IKey;
  /** Security Hub severity labels that trigger a notification (e.g. `CRITICAL`, `HIGH`). */
  readonly severities: string[];
  /** Email addresses subscribed to the topic. Empty creates the topic without subscribers. */
  readonly emails: string[];
  /** Delete the DLQ on stack deletion (non-production only). */
  readonly isAutoDeleteObject: boolean;
}

/** Retries per delivery before an event goes to the DLQ. */
export const NOTIFICATION_RETRY_ATTEMPTS = 3;
/** Maximum age of an event EventBridge keeps retrying to deliver. */
export const NOTIFICATION_MAX_EVENT_AGE_MINUTES = 60;

/**
 * Security Hub findings to email: an EventBridge rule on newly imported, active findings at the configured
 * severities, an SNS topic (CMK-encrypted, TLS-only) and optional email subscriptions.
 *
 * GuardDuty, AWS Config and IAM Access Analyzer findings all reach Security Hub, so one rule covers every
 * source. Detection-only stays true: this only tells a person; it changes nothing.
 */
export class NotificationConstruct extends Construct {
  /** Topic the findings are published to. */
  public readonly topic: sns.ITopic;
  /** Rule that matches the findings. */
  public readonly rule: events.IRule;
  /** Queue for events EventBridge could not deliver to the topic. */
  public readonly dlq: sqs.IQueue;

  /**
   * Creates the topic, subscriptions, DLQ and rule, and lets EventBridge use the key.
   *
   * @param scope - parent construct
   * @param id - construct ID
   * @param props - notification settings
   */
  constructor(scope: Construct, id: string, props: NotificationConstructProps) {
    super(scope, id);

    const removalPolicy = props.isAutoDeleteObject
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.RETAIN;

    // EventBridge publishes to a topic encrypted with a customer managed key only if the key policy allows the
    // service. Scoped to this account rather than the rule ARN, which would make the key depend on the rule.
    props.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEventBridgeToUseKeyForFindingsTopic',
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account } },
      })
    );

    const topic = new sns.Topic(this, 'Topic', {
      topicName: `${props.namePrefix}-findings`,
      displayName: 'Security baseline findings',
      masterKey: props.key,
      enforceSSL: true,
    });
    props.emails.forEach((email) =>
      topic.addSubscription(new subscriptions.EmailSubscription(email))
    );

    // Events EventBridge could not deliver to the topic after all retries land here.
    const dlq = new sqs.Queue(this, 'Dlq', {
      queueName: `${props.namePrefix}-findings-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    const rule = new events.Rule(this, 'Rule', {
      ruleName: `${props.namePrefix}-findings`,
      description: `Security Hub findings (${props.severities.join(', ')}) that are new and active`,
      eventPattern: {
        source: ['aws.securityhub'],
        detailType: ['Security Hub Findings - Imported'],
        detail: {
          findings: {
            Severity: { Label: props.severities },
            Workflow: { Status: ['NEW'] },
            RecordState: ['ACTIVE'],
          },
        },
      },
      targets: [
        new targets.SnsTopic(topic, {
          deadLetterQueue: dlq,
          retryAttempts: NOTIFICATION_RETRY_ATTEMPTS,
          maxEventAge: cdk.Duration.minutes(NOTIFICATION_MAX_EVENT_AGE_MINUTES),
          // A short, readable message instead of the raw envelope.
          message: events.RuleTargetInput.fromText(
            [
              `[${events.EventField.fromPath('$.detail.findings[0].Severity.Label')}] ${events.EventField.fromPath('$.detail.findings[0].Title')}`,
              `Account: ${events.EventField.fromPath('$.detail.findings[0].AwsAccountId')}  Region: ${events.EventField.fromPath('$.detail.findings[0].Region')}`,
              `Product: ${events.EventField.fromPath('$.detail.findings[0].ProductName')}`,
              `Resource: ${events.EventField.fromPath('$.detail.findings[0].Resources[0].Id')}`,
              `Finding ID: ${events.EventField.fromPath('$.detail.findings[0].Id')}`,
            ].join('\n')
          ),
        }),
      ],
    });

    this.topic = topic;
    this.dlq = dlq;
    this.rule = rule;
  }
}
