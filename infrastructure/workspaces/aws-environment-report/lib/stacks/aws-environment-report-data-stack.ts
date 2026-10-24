import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { DEFAULT_WEBHOOK_SECRET } from 'src/lambda/common/webhook-config';

export interface AwsEnvironmentReportDataStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Stateful stack: the report bucket, its KMS key and the webhook secret.
 *
 * Bucket layout:
 *   raw/YYYY-MM/<source>.json  collector output (expires after retention.rawDays)
 *   reports/YYYY-MM/...        the report itself; manifest.json is written last
 *                              and doubles as the "this month is done" marker
 *   reports/latest/...         copy of the newest month
 *
 * The layout is already a static site, so a later internal ALB or CloudFront
 * delivery only has to sit in front of `reports/`. That delivery gets its own
 * bucket: the internal ALB + S3 PrivateLink pattern requires the bucket name
 * to equal the host name, and a bucket cannot be renamed.
 */
export class AwsEnvironmentReportDataStack extends cdk.Stack {
  public readonly bucket: s3.IBucket;
  public readonly key: kms.IKey;
  public readonly webhookSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: AwsEnvironmentReportDataStackProps) {
    super(scope, id, props);

    const namePrefix = `${props.project}-${props.environment}`;
    const removalPolicy = props.isAutoDeleteObject
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.RETAIN;

    const key = new kms.Key(this, 'Key', {
      alias: `alias/${namePrefix}-environment-report`,
      description: 'Encrypts the environment report bucket and webhook secret',
      enableKeyRotation: true,
      removalPolicy,
    });
    this.key = key;

    const bucket = new s3.Bucket(this, 'ReportBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        {
          id: 'expire-raw',
          prefix: 'raw/',
          expiration: cdk.Duration.days(props.params.retention.rawDays),
        },
        {
          id: 'expire-noncurrent',
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      removalPolicy,
      autoDeleteObjects: props.isAutoDeleteObject,
    });
    this.bucket = bucket;

    // The value is a placeholder, not a secret: operators replace the URLs by
    // hand after deploy. The notifier refuses to send while it is unchanged.
    const webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      secretName: `${namePrefix}-environment-report-webhooks`,
      description:
        'Slack / Teams webhook URLs for the environment report. Edit by hand; the default sends nothing.',
      encryptionKey: key,
      secretStringValue: cdk.SecretValue.unsafePlainText(DEFAULT_WEBHOOK_SECRET),
      removalPolicy,
    });
    this.webhookSecret = webhookSecret;

    new cdk.CfnOutput(this, 'ReportBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'WebhookSecretName', { value: webhookSecret.secretName });
  }
}
