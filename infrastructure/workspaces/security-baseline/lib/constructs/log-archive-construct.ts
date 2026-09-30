import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/** Properties for {@link LogArchiveConstruct}. */
export interface LogArchiveConstructProps {
  /** Days before archived objects expire. */
  readonly expirationDays: number;
  /** Delete the bucket and its objects on stack deletion (non-production only). */
  readonly isAutoDeleteObject: boolean;
}

/**
 * The account's audit-log archive: one private, versioned S3 bucket shared by CloudTrail and AWS Config,
 * and the customer managed KMS key used to encrypt CloudTrail log files and the findings topic.
 */
export class LogArchiveConstruct extends Construct {
  /** Bucket that receives CloudTrail and AWS Config deliveries. */
  public readonly bucket: s3.IBucket;
  /** Customer managed key for CloudTrail log files and the findings SNS topic. */
  public readonly key: kms.IKey;

  /**
   * Creates the KMS key and the hardened bucket.
   *
   * @param scope - parent construct
   * @param id - construct ID
   * @param props - archive settings
   */
  constructor(scope: Construct, id: string, props: LogArchiveConstructProps) {
    super(scope, id);

    const removalPolicy = props.isAutoDeleteObject
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.RETAIN;

    this.key = new kms.Key(this, 'Key', {
      description: 'Security baseline key: CloudTrail log files and the findings topic',
      enableKeyRotation: true,
      removalPolicy,
    });

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // CloudTrail encrypts each log file with the CMK above; Config objects use the bucket default (SSE-S3).
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        {
          id: 'expire-audit-logs',
          expiration: cdk.Duration.days(props.expirationDays),
          noncurrentVersionExpiration: cdk.Duration.days(props.expirationDays),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      removalPolicy,
      autoDeleteObjects: props.isAutoDeleteObject,
    });
  }
}
