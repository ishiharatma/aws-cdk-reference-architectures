import * as cdk from 'aws-cdk-lib';
import * as config from 'aws-cdk-lib/aws-config';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/** Properties for {@link ConfigConstruct}. */
export interface ConfigConstructProps {
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
 * AWS Config: one configuration recorder (all supported resource types, including global ones), one
 * delivery channel to the log archive, and a set of managed rules. Security Hub controls read Config
 * data, so the recorder is exposed for ordering.
 */
export class ConfigConstruct extends Construct {
  /** The configuration recorder (there can be only one per Region per account). */
  public readonly recorder: config.CfnConfigurationRecorder;

  /**
   * Creates the recorder role, bucket permissions, recorder, delivery channel and managed rules.
   *
   * @param scope - parent construct
   * @param id - construct ID
   * @param props - Config settings
   */
  constructor(scope: Construct, id: string, props: ConfigConstructProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

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

    this.recorder = new config.CfnConfigurationRecorder(this, 'Recorder', {
      roleArn: role.roleArn,
      recordingGroup: {
        allSupported: true,
        includeGlobalResourceTypes: true,
      },
    });

    const channel = new config.CfnDeliveryChannel(this, 'DeliveryChannel', {
      s3BucketName: props.bucket.bucketName,
      s3KeyPrefix: CONFIG_KEY_PREFIX,
      configSnapshotDeliveryProperties: { deliveryFrequency: 'TwentyFour_Hours' },
    });
    // The channel is validated against the bucket policy on creation, and needs a recorder to exist.
    channel.node.addDependency(props.bucket);
    channel.node.addDependency(this.recorder);

    for (const identifier of MANAGED_RULES) {
      const rule = new config.ManagedRule(this, `Rule${identifier}`, { identifier });
      rule.node.addDependency(this.recorder);
    }
  }
}
