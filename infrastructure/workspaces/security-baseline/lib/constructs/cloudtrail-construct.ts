import * as cdk from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/** Properties for {@link CloudTrailConstruct}. */
export interface CloudTrailConstructProps {
  /** Trail name. */
  readonly trailName: string;
  /** Bucket the trail delivers to (the bucket policy is added by the trail). */
  readonly bucket: s3.IBucket;
  /** Customer managed key that encrypts the log files. */
  readonly key: kms.IKey;
  /** Retention of the CloudWatch Logs log group, in days. */
  readonly logGroupRetentionDays: number;
  /** Delete the log group on stack deletion (non-production only). */
  readonly isAutoDeleteObject: boolean;
}

/**
 * A multi-Region CloudTrail trail with log file validation, delivered to S3 (KMS-encrypted) and CloudWatch Logs.
 * Management events only: data events are billed per event and are a per-workload decision.
 */
export class CloudTrailConstruct extends Construct {
  /** The trail. */
  public readonly trail: cloudtrail.Trail;

  /**
   * Creates the trail, its CloudWatch Logs delivery and the log group removal policy.
   *
   * @param scope - parent construct
   * @param id - construct ID
   * @param props - trail settings
   */
  constructor(scope: Construct, id: string, props: CloudTrailConstructProps) {
    super(scope, id);

    // The CDK Trail construct manages the bucket policy automatically, but not the KMS key policy: with a
    // customer managed key, CloudTrail needs an explicit grant to encrypt log files and describe the key, or
    // delivery fails with "Insufficient permissions to access S3 bucket ... or KMS key".
    props.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudTrailToEncryptLogs',
        principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['kms:GenerateDataKey*'],
        resources: ['*'],
        conditions: {
          StringLike: {
            'kms:EncryptionContext:aws:cloudtrail:arn': `arn:${cdk.Aws.PARTITION}:cloudtrail:*:${cdk.Aws.ACCOUNT_ID}:trail/*`,
          },
        },
      })
    );
    props.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudTrailToDescribeKey',
        principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['kms:DescribeKey'],
        resources: ['*'],
      })
    );

    this.trail = new cloudtrail.Trail(this, 'Resource', {
      trailName: props.trailName,
      bucket: props.bucket,
      s3KeyPrefix: 'cloudtrail',
      encryptionKey: props.key,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
      sendToCloudWatchLogs: true,
      cloudWatchLogsRetention: props.logGroupRetentionDays as logs.RetentionDays,
    });

    if (props.isAutoDeleteObject) {
      this.trail.logGroup?.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }
  }
}
