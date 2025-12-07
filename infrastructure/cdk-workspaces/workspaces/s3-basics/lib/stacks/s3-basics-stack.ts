import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Environment } from "@common/parameters/environments";

export interface StackProps extends cdk.StackProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
}

export class S3BasicStack extends cdk.Stack {
  public readonly bucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;
    // exclude hyphens from region
    const regionNoHyphens = region.replace(/-/g, "");

    // Example with all default settings
    this.bucket = new s3.Bucket(this, "CDKDefault", {});

    // named bucket
    const bucketName = [
      props.project, // プロジェクト名
      props.environment, // 環境識別子
      "namedbucket", // 用途
      accountId, // AWSアカウントID
      regionNoHyphens, // リージョン（ハイフン除去）
    ]
      .join("-")
      .toLowerCase();
    new s3.Bucket(this, "NamedBucket", {
      bucketName,
      autoDeleteObjects: props.isAutoDeleteObject,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new s3.Bucket(this, "AutoDeleteObjects", {
      autoDeleteObjects: props.isAutoDeleteObject,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Block public access off
    new s3.Bucket(this, "BlockPublicAccessOff", {
      blockPublicAccess: new s3.BlockPublicAccess({ blockPublicPolicy: false }),
      autoDeleteObjects: props.isAutoDeleteObject,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Example with customized settings
    // encryption, bucket name, auto delete objects
    new s3.Bucket(this, "EncryptionSSEKMSManaged", {
      encryption: s3.BucketEncryption.KMS_MANAGED,
      autoDeleteObjects: props.isAutoDeleteObject,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new s3.Bucket(this, "EncryptionSSEKMSCustomer", {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: new cdk.aws_kms.Key(this, "CustomKmsKey", {
        enableKeyRotation: true,
      }),
      autoDeleteObjects: props.isAutoDeleteObject,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // Lifecycle rules can be added as needed
    const lifecycleBucket = new s3.Bucket(this, "LifecycleRules", {
      lifecycleRules: [
        {
          id: "MoveToIAAfter30Days",
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
      autoDeleteObjects: props.isAutoDeleteObject,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // Adding more lifecycle rules
    lifecycleBucket.addLifecycleRule({
      id: "MoveToGlacierAfter90Days",
      enabled: true,
      transitions: [
        {
          storageClass: s3.StorageClass.GLACIER,
          transitionAfter: cdk.Duration.days(90),
        },
      ],
    });
    lifecycleBucket.addLifecycleRule({
      id: "ExpireAfter365Days",
      enabled: true,
      expiration: cdk.Duration.days(365),
    });

    // Versioning enabled bucket
    new s3.Bucket(this, "VersioningEnabled", {
      versioned: true,
      autoDeleteObjects: props.isAutoDeleteObject,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          id: "ExpireNonCurrentVersionsAfter90Days",
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(90),
          noncurrentVersionsToRetain: 3,
        },
        {
          id: "NonCurrentVersionTransitionToIAAfter30Days",
          enabled: true,
          noncurrentVersionTransitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
        {
          id: "CurrentVersionTransitionToIAAfter60Days",
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(60),
            },
          ],
        },
        {
          id: "CurrentVersionTransitionToGlacierAfter90Days",
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
        {
          id: "ExpireCurrentVersionsAfter365Days",
          enabled: true,
          expiration: cdk.Duration.days(365),
        },
        {
          id: "AbortIncompleteMultipartUploadsAfter7Days",
          enabled: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });
  }
}
