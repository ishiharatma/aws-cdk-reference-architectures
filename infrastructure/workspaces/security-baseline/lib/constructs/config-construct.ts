import * as cdk from 'aws-cdk-lib';
import * as config from 'aws-cdk-lib/aws-config';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/** Properties for {@link ConfigConstruct}. */
export interface ConfigConstructProps {
  /** Prefix for the recorder and delivery channel names. */
  readonly namePrefix: string;
  /** Bucket AWS Config delivers configuration history and snapshots to. */
  readonly bucket: s3.IBucket;
}

/** Key prefix Config writes under; the bucket policy grants PutObject on exactly this prefix. */
export const CONFIG_KEY_PREFIX = 'config';

/**
 * AWS managed rules that need no parameters. A small, high-signal set: public S3, TLS-only S3, root account
 * hygiene, IAM hygiene, unencrypted storage, world-open SSH, and "is CloudTrail on". Extend per workload.
 */
export const MANAGED_RULES: readonly string[] = [
  config.ManagedRuleIdentifiers.S3_BUCKET_LEVEL_PUBLIC_ACCESS_PROHIBITED,
  config.ManagedRuleIdentifiers.S3_BUCKET_PUBLIC_READ_PROHIBITED,
  config.ManagedRuleIdentifiers.S3_BUCKET_SSL_REQUESTS_ONLY,
  config.ManagedRuleIdentifiers.ROOT_ACCOUNT_MFA_ENABLED,
  config.ManagedRuleIdentifiers.IAM_ROOT_ACCESS_KEY_CHECK,
  config.ManagedRuleIdentifiers.IAM_USER_NO_POLICIES_CHECK,
  config.ManagedRuleIdentifiers.ACCESS_KEYS_ROTATED,
  config.ManagedRuleIdentifiers.CLOUD_TRAIL_ENABLED,
  config.ManagedRuleIdentifiers.EBS_ENCRYPTED_VOLUMES,
  config.ManagedRuleIdentifiers.RDS_STORAGE_ENCRYPTED,
  // No CDK constant for this one; the string is the AWS managed rule's source identifier (rule name: restricted-ssh).
  'INCOMING_SSH_DISABLED',
];

/**
 * Input parameters for the managed rules above that require one. `ACCESS_KEYS_ROTATED` fails to create
 * ("required parameter [maxAccessKeyAge] is not present") without `maxAccessKeyAge`; every other rule in
 * `MANAGED_RULES` needs none.
 */
const RULE_INPUT_PARAMETERS: Partial<Record<string, Record<string, string>>> = {
  [config.ManagedRuleIdentifiers.ACCESS_KEYS_ROTATED]: { maxAccessKeyAge: '90' },
};

/**
 * AWS Config: one configuration recorder (all supported resource types, including global ones), one
 * delivery channel to the log archive, and a set of managed rules. Security Hub controls read Config
 * data, so `recorderReady` is exposed for ordering.
 *
 * The recorder and delivery channel are created through `AwsCustomResource` direct SDK calls, not the
 * native `CfnConfigurationRecorder` / `CfnDeliveryChannel` L1 resources. CloudFormation's own resource
 * handler for `AWS::Config::ConfigurationRecorder` calls `StartConfigurationRecorder` as part of its
 * create-time stabilization check, which needs a delivery channel to already exist
 * (`NoAvailableDeliveryChannelException` otherwise) — but `PutDeliveryChannel` needs the recorder to
 * already exist (`NoAvailableConfigurationRecorderException` otherwise). Neither declaration order of
 * the two native resources satisfies both requirements, so the native resource always fails with
 * `HandlerErrorCode: NotStabilized`. Calling the three APIs directly, in the only order that actually
 * works (put recorder, put channel, start recorder), avoids CloudFormation's broken stabilization check
 * entirely. See `docs/knowledge/aws-service-gotchas.md`.
 */
export class ConfigConstruct extends Construct {
  /** Dependable that is ready once the recorder exists, has a delivery channel, and is recording. */
  public readonly recorderReady: Construct;

  /**
   * Creates the recorder role, bucket permissions, recorder, delivery channel, starts recording and
   * creates the managed rules.
   *
   * @param scope - parent construct
   * @param id - construct ID
   * @param props - Config settings
   */
  constructor(scope: Construct, id: string, props: ConfigConstructProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const recorderName = `${props.namePrefix}-recorder`;
    const channelName = `${props.namePrefix}-channel`;

    // The recorder assumes this role to read resource configurations.
    const role = new iam.Role(this, 'RecorderRole', {
      assumedBy: new iam.ServicePrincipal('config.amazonaws.com'),
      description: 'AWS Config recorder role',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWS_ConfigRole')],
    });

    // Delivery is done by the Config service principal, so the bucket policy (not the role) grants it.
    const deliveryConditions = { StringEquals: { 'aws:SourceAccount': stack.account } };
    props.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSConfigBucketPermissionsCheck',
        principals: [new iam.ServicePrincipal('config.amazonaws.com')],
        actions: ['s3:GetBucketAcl', 's3:ListBucket'],
        resources: [props.bucket.bucketArn],
        conditions: deliveryConditions,
      })
    );
    props.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSConfigBucketDelivery',
        principals: [new iam.ServicePrincipal('config.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [
          props.bucket.arnForObjects(`${CONFIG_KEY_PREFIX}/AWSLogs/${stack.account}/Config/*`),
        ],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': stack.account,
            's3:x-amz-acl': 'bucket-owner-full-control',
          },
        },
      })
    );

    // Config's recorder/channel/start-recording APIs are account-and-Region singletons with no resource
    // ARNs to scope to; iam:PassRole is scoped to the recorder role specifically.
    const sdkCallPolicy = cr.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: [
          'config:PutConfigurationRecorder',
          'config:DeleteConfigurationRecorder',
          'config:StartConfigurationRecorder',
          'config:StopConfigurationRecorder',
          'config:PutDeliveryChannel',
          'config:DeleteDeliveryChannel',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [role.roleArn],
      }),
    ]);

    const recorder = new cr.AwsCustomResource(this, 'Recorder', {
      resourceType: 'Custom::ConfigConfigurationRecorder',
      onCreate: {
        service: 'ConfigService',
        action: 'putConfigurationRecorder',
        parameters: {
          ConfigurationRecorder: {
            name: recorderName,
            roleARN: role.roleArn,
            recordingGroup: { allSupported: true, includeGlobalResourceTypes: true },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(recorderName),
      },
      onUpdate: {
        service: 'ConfigService',
        action: 'putConfigurationRecorder',
        parameters: {
          ConfigurationRecorder: {
            name: recorderName,
            roleARN: role.roleArn,
            recordingGroup: { allSupported: true, includeGlobalResourceTypes: true },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(recorderName),
      },
      onDelete: {
        service: 'ConfigService',
        action: 'deleteConfigurationRecorder',
        parameters: { ConfigurationRecorderName: recorderName },
      },
      policy: sdkCallPolicy,
    });
    recorder.node.addDependency(role);

    const channel = new cr.AwsCustomResource(this, 'DeliveryChannel', {
      resourceType: 'Custom::ConfigDeliveryChannel',
      onCreate: {
        service: 'ConfigService',
        action: 'putDeliveryChannel',
        parameters: {
          DeliveryChannel: {
            name: channelName,
            s3BucketName: props.bucket.bucketName,
            s3KeyPrefix: CONFIG_KEY_PREFIX,
            configSnapshotDeliveryProperties: { deliveryFrequency: 'TwentyFour_Hours' },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(channelName),
      },
      onUpdate: {
        service: 'ConfigService',
        action: 'putDeliveryChannel',
        parameters: {
          DeliveryChannel: {
            name: channelName,
            s3BucketName: props.bucket.bucketName,
            s3KeyPrefix: CONFIG_KEY_PREFIX,
            configSnapshotDeliveryProperties: { deliveryFrequency: 'TwentyFour_Hours' },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(channelName),
      },
      onDelete: {
        service: 'ConfigService',
        action: 'deleteDeliveryChannel',
        parameters: { DeliveryChannelName: channelName },
      },
      policy: sdkCallPolicy,
    });
    // PutDeliveryChannel fails with NoAvailableConfigurationRecorderException if the recorder doesn't
    // already exist, so the channel must come after it (and after the bucket policy it is validated against).
    channel.node.addDependency(props.bucket);
    channel.node.addDependency(recorder);

    const startRecording = new cr.AwsCustomResource(this, 'StartRecording', {
      resourceType: 'Custom::ConfigStartRecording',
      onCreate: {
        service: 'ConfigService',
        action: 'startConfigurationRecorder',
        parameters: { ConfigurationRecorderName: recorderName },
        physicalResourceId: cr.PhysicalResourceId.of(`${recorderName}-started`),
      },
      // Deleting the delivery channel fails ("there is a running configuration recorder") unless
      // recording has stopped first; this runs before the channel's own onDelete since it was created
      // after it (CloudFormation deletes in reverse dependency order).
      onDelete: {
        service: 'ConfigService',
        action: 'stopConfigurationRecorder',
        parameters: { ConfigurationRecorderName: recorderName },
      },
      policy: sdkCallPolicy,
    });
    // StartConfigurationRecorder fails with NoAvailableDeliveryChannelException without a channel.
    startRecording.node.addDependency(channel);

    this.recorderReady = startRecording;

    for (const identifier of MANAGED_RULES) {
      const rule = new config.ManagedRule(this, `Rule${identifier}`, {
        identifier,
        inputParameters: RULE_INPUT_PARAMETERS[identifier],
      });
      rule.node.addDependency(startRecording);
    }
  }
}
