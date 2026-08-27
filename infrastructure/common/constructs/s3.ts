import * as crypto from 'crypto';
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { Environment } from '../parameters/environments';
import { S3LifecycleConfig } from '../types/s3';

/**
 * Options for {@link createAccountRegionalBucket}.
 */
export interface CreateAccountRegionalBucketOptions {
  /** Construct scope in which the bucket is created (the caller's `this`). */
  readonly scope: Construct;
  /** Construct ID of the bucket (used for the logical ID; take care to preserve compatibility with existing callers). */
  readonly id: string;
  /** Project name (used in the bucket name). */
  readonly project: string;
  /** Deployment environment (used in the bucket name). */
  readonly environment: Environment;
  /** Short identifier for the bucket's purpose (e.g. `sftp-inbound`, `audit-log`). Used in the bucket name. Ignored when `bucketNameOverride` is specified. */
  readonly purpose: string;
  /**
   * Replaces the default `<project>-<environment>-<purpose>` bucket name prefix. Use this when
   * AWS imposes a naming constraint (e.g. WAF log buckets require an `aws-waf-logs-` prefix).
   * The value is still passed through {@link normalizeBucketName}; it must only contain literal,
   * already-lowercase segments, because embedding an unresolved CDK token (such as `Stack.account`
   * on an environment-agnostic stack) cannot be normalized safely.
   */
  readonly bucketNameOverride?: string;
  /** Access control policy for the bucket. */
  readonly accessControl?: s3.BucketAccessControl;
  /**
   * S3 Object Ownership setting. Required to be something other than `BUCKET_OWNER_ENFORCED`
   * (which disables ACLs) when the bucket is used as a CloudFront/S3 server access log
   * destination, since log delivery relies on ACL grants.
   * @default - CloudFormation default (`BucketOwnerEnforced`, i.e. ACLs disabled)
   */
  readonly objectOwnership?: s3.ObjectOwnership;
  /** Whether to auto-delete objects in the bucket on stack deletion. Defaults to false. */
  readonly autoDeleteObjects?: boolean;
  /** Destination bucket for server access logs. Required when `serverAccessLogsPrefix` is specified. */
  readonly serverAccessLogsBucket?: s3.IBucket;
  /** Prefix for server access logs. When specified, `serverAccessLogsBucket` must also be specified (omitting it would cause the bucket to log to itself, which this helper disallows). */
  readonly serverAccessLogsPrefix?: string;
  /** Lifecycle configuration to apply. When unspecified, no lifecycle rules are created. */
  readonly lifecycle?: S3LifecycleConfig;
  /** Whether to enable versioning. Defaults to true. */
  readonly versioned?: boolean;
  /** Encryption method. Defaults to `S3_MANAGED` (SSE-S3). */
  readonly encryption?: s3.BucketEncryption;
  /** KMS key to use when `encryption` is `KMS`. */
  readonly encryptionKey?: kms.IKey;
  /** Removal policy. Defaults to `RETAIN`. */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * Creates an S3 bucket in the account-regional namespace
 * (`BucketNamespace: account-regional`), set through the native `bucketNamespace` /
 * `bucketNamePrefix` L2 props. S3 appends an account- and region-specific suffix to the
 * prefix at creation time, so only the prefix is supplied here: `<project>-<environment>-<purpose>`
 * by default (trimmed to fit S3's length limit by {@link buildPurposeBucketNamePrefix}), or
 * `bucketNameOverride` when a service mandates a specific prefix.
 */
export function createAccountRegionalBucket(options: CreateAccountRegionalBucketOptions): s3.Bucket {
  if (options.serverAccessLogsPrefix !== undefined && options.serverAccessLogsBucket === undefined) {
    // Omitting serverAccessLogsBucket would cause CDK to fall back to the bucket logging to itself,
    // so this helper explicitly disallows that to avoid unintended self-logging.
    throw new Error(
      `createAccountRegionalBucket(${options.id}): serverAccessLogsBucket must also be specified when serverAccessLogsPrefix is set (omitting it would cause the bucket to deliver access logs to itself).`
    );
  }

  const bucketNamePrefix = normalizeBucketName(
    options.bucketNameOverride ??
    buildPurposeBucketNamePrefix(options.project, options.environment, options.purpose)
  );

  const bucket = new s3.Bucket(options.scope, options.id, {
    bucketNamePrefix: bucketNamePrefix,
    bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    versioned: options.versioned ?? true,
    accessControl: options.accessControl,
    objectOwnership: options.objectOwnership,
    encryption: options.encryption ?? s3.BucketEncryption.S3_MANAGED,
    encryptionKey: options.encryptionKey,
    removalPolicy: options.removalPolicy ?? (options.autoDeleteObjects ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN),
    autoDeleteObjects: options.autoDeleteObjects,
    serverAccessLogsBucket: options.serverAccessLogsBucket,
    serverAccessLogsPrefix: options.serverAccessLogsPrefix,
    lifecycleRules: buildLifecycleRules(options.lifecycle, options.versioned ?? true),
  });

  // Add a lifecycle rule to abort incomplete multipart uploads (S3 best practice)
  bucket.addLifecycleRule({
    id: 'AbortIncompleteMultipartUpload',
    enabled: true,
    abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
  });

  return bucket;
}

/**
 * Retained as a worked example of the pre-native approach: build a fully explicit bucket name
 * (`<project>-<environment>-<purpose>-<accountId>-<region>-an`) and attach the account-regional
 * namespace through the L1 escape hatch. Prefer {@link createAccountRegionalBucket}, which uses
 * the native `bucketNamespace` / `bucketNamePrefix` props; this variant is kept only for reference.
 *
 * Throws an error if `serverAccessLogsPrefix` is set without specifying `serverAccessLogsBucket`.
 */
export function createAccountRegionalBucketEscapeHatch(options: CreateAccountRegionalBucketOptions): s3.Bucket {
  if (options.serverAccessLogsPrefix !== undefined && options.serverAccessLogsBucket === undefined) {
    // Omitting serverAccessLogsBucket would cause CDK to fall back to the bucket logging to itself,
    // so this helper explicitly disallows that to avoid unintended self-logging.
    throw new Error(
      `createAccountRegionalBucket(${options.id}): serverAccessLogsBucket must also be specified when serverAccessLogsPrefix is set (omitting it would cause the bucket to deliver access logs to itself).`
    );
  }

  const stack = cdk.Stack.of(options.scope);
  const accountId = stack.account;
  const region = stack.region;
  // Only set an explicit name when the account resolves to a literal 12-digit id. On an
  // environment-agnostic stack `stack.account` is an unresolved token, which would both break
  // the length arithmetic in buildPurposeBucketName and be mangled by normalizeBucketName, so
  // fall back to CDK's auto-naming instead.
  const explicitBucketName =
    /^[0-9]{12}$/.test(accountId) && region
      ? normalizeBucketName(
          options.bucketNameOverride ??
            buildPurposeBucketName(options.project, options.environment, options.purpose, accountId, region)
        )
      : undefined;

  const bucket = new s3.Bucket(options.scope, options.id, {
    ...(explicitBucketName ? { bucketName: explicitBucketName } : {}),
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    versioned: options.versioned ?? true,
    accessControl: options.accessControl,
    objectOwnership: options.objectOwnership,
    encryption: options.encryption ?? s3.BucketEncryption.S3_MANAGED,
    encryptionKey: options.encryptionKey,
    removalPolicy: options.removalPolicy ?? (options.autoDeleteObjects ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN),
    autoDeleteObjects: options.autoDeleteObjects,
    serverAccessLogsBucket: options.serverAccessLogsBucket,
    serverAccessLogsPrefix: options.serverAccessLogsPrefix,
    lifecycleRules: buildLifecycleRules(options.lifecycle, options.versioned ?? true),
  });

  // Add a lifecycle rule to abort incomplete multipart uploads (S3 best practice)
  bucket.addLifecycleRule({
    id: 'AbortIncompleteMultipartUpload',
    enabled: true,
    abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
  });

  if (explicitBucketName) {
    // Add BucketNamespace via escape hatch (replace once a native L2 API becomes available)
    const cfnBucket = bucket.node.defaultChild as s3.CfnBucket;
    cfnBucket.addPropertyOverride('BucketNamespace', 'account-regional');
  }

  return bucket;
}

/**
 * Creates an account-regional S3 bucket configured for website hosting.
 */
export function createAccountRegionalBucketWebSite(options: CreateAccountRegionalBucketOptions): s3.Bucket {
  if (options.serverAccessLogsPrefix !== undefined && options.serverAccessLogsBucket === undefined) {
    // Omitting serverAccessLogsBucket would cause CDK to fall back to the bucket logging to itself,
    // so this helper explicitly disallows that to avoid unintended self-logging.
    throw new Error(
      `createAccountRegionalBucket(${options.id}): serverAccessLogsBucket must also be specified when serverAccessLogsPrefix is set (omitting it would cause the bucket to deliver access logs to itself).`
    );
  }

  const bucketNamePrefix = normalizeBucketName(
    options.bucketNameOverride ??
    buildPurposeBucketNamePrefix(options.project, options.environment, options.purpose)
  );

  const bucket = new s3.Bucket(options.scope, options.id, {
    bucketNamePrefix,
    bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: false,
    versioned: options.versioned ?? true,
    accessControl: options.accessControl,
    objectOwnership: options.objectOwnership,
    encryption: options.encryption ?? s3.BucketEncryption.S3_MANAGED,
    encryptionKey: options.encryptionKey,
    removalPolicy: options.removalPolicy ?? (options.autoDeleteObjects ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN),
    autoDeleteObjects: options.autoDeleteObjects,
    serverAccessLogsBucket: options.serverAccessLogsBucket,
    serverAccessLogsPrefix: options.serverAccessLogsPrefix,
    websiteIndexDocument: 'index.html',
    websiteErrorDocument: 'error.html',
  });

  return bucket;
}


/**
 * Builds S3 lifecycle rules from {@link S3LifecycleConfig}.
 * Returns `undefined` (adding no lifecycle rules) if none of the config values are set.
 *
 * When `versioned` is true, the same day thresholds are also applied to noncurrent
 * versions for storage class transitions and expiration. On versioned buckets,
 * `expiration` (for the current version) only adds a delete marker while the object
 * body remains as a noncurrent version, so without `noncurrentVersionExpiration`
 * storage would grow without bound.
 */
function buildLifecycleRules(lifecycle: S3LifecycleConfig | undefined, versioned: boolean): s3.LifecycleRule[] | undefined {
  if (
    !lifecycle ||
    (lifecycle.standardIaDays === undefined &&
      lifecycle.intelligentTieringDays === undefined &&
      lifecycle.glacierFlexibleDays === undefined &&
      lifecycle.glacierDeepArchiveDays === undefined &&
      lifecycle.expirationDays === undefined)
  ) {
    return undefined;
  }

  if (lifecycle.standardIaDays !== undefined && lifecycle.intelligentTieringDays !== undefined) {
    // AWS does not allow transitioning from Standard-IA/One Zone-IA to Intelligent-Tiering,
    // so the two cannot be combined in the same rule (choose one or the other).
    throw new Error('S3LifecycleConfig: standardIaDays and intelligentTieringDays cannot be used together.');
  }

  const buildTransitions = (): { storageClass: s3.StorageClass; transitionAfter: cdk.Duration }[] => [
    ...(lifecycle.standardIaDays !== undefined
      ? [{ storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(lifecycle.standardIaDays) }]
      : []),
    ...(lifecycle.intelligentTieringDays !== undefined
      ? [{ storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: cdk.Duration.days(lifecycle.intelligentTieringDays) }]
      : []),
    ...(lifecycle.glacierFlexibleDays !== undefined
      ? [{ storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(lifecycle.glacierFlexibleDays) }]
      : []),
    ...(lifecycle.glacierDeepArchiveDays !== undefined
      ? [{ storageClass: s3.StorageClass.DEEP_ARCHIVE, transitionAfter: cdk.Duration.days(lifecycle.glacierDeepArchiveDays) }]
      : []),
  ];

  return [
    {
      id: 'DefaultLifecycle',
      enabled: true,
      transitions: buildTransitions(),
      ...(lifecycle.expirationDays !== undefined ? { expiration: cdk.Duration.days(lifecycle.expirationDays) } : {}),
      ...(versioned
        ? {
            noncurrentVersionTransitions: buildTransitions(),
            ...(lifecycle.expirationDays !== undefined
              ? { noncurrentVersionExpiration: cdk.Duration.days(lifecycle.expirationDays) }
              : {}),
          }
        : {}),
    },
  ];
}

/**
 * Maximum length of `bucketNamePrefix` for the account-regional namespace. S3 appends its own
 * account/region suffix to reach the 63-character bucket-name limit, so CloudFormation rejects
 * any prefix longer than this.
 */
const ACCOUNT_REGIONAL_PREFIX_MAX_LENGTH = 37;

/**
 * Builds a bucket name prefix in the form `<project>-<environment>-<purpose>`, kept within
 * {@link ACCOUNT_REGIONAL_PREFIX_MAX_LENGTH}. If the name would exceed that limit, only the
 * `purpose` segment is truncated and a short hash derived from the original `purpose` is
 * appended so the prefix stays unique.
 */
function buildPurposeBucketNamePrefix(
  project: string,
  environment: string,
  purpose: string,
): string {
  const prefix = `${project}-${environment}-`;
  const fullName = `${prefix}${purpose}`;
  if (fullName.length <= ACCOUNT_REGIONAL_PREFIX_MAX_LENGTH) {
    return fullName;
  }

  const hash = crypto.createHash('sha1').update(purpose).digest('hex').slice(0, 8);
  const maxPurposeLength = Math.max(1, ACCOUNT_REGIONAL_PREFIX_MAX_LENGTH - prefix.length - hash.length - 1);
  return `${prefix}${purpose.slice(0, maxPurposeLength)}-${hash}`;
}

/**
 * Builds a bucket name in the form `<project>-<environment>-<purpose>-<accountId>-<region>-an`.
 * S3 bucket names are limited to 63 characters, so if the name would exceed that limit,
 * only the `purpose` segment is truncated and a short hash derived from the original
 * `purpose` is appended to keep the name unique while staying within the limit.
 */
function buildPurposeBucketName(
  project: string,
  environment: string,
  purpose: string,
  accountId: string,
  region: string
): string {
  const prefix = `${project}-${environment}-`;
  const suffix = `-${accountId}-${region}-an`;
  const fullName = `${prefix}${purpose}${suffix}`;
  if (fullName.length <= 63) {
    return fullName;
  }

  const hash = crypto.createHash('sha1').update(purpose).digest('hex').slice(0, 8);
  const maxPurposeLength = Math.max(1, 63 - prefix.length - suffix.length - hash.length - 1);
  return `${prefix}${purpose.slice(0, maxPurposeLength)}-${hash}${suffix}`;
}
/**
 * Normalizes a resolved string into a valid S3 bucket name (segment): lowercases it,
 * replaces every character outside `[a-z0-9.-]` with a hyphen, collapses runs of hyphens,
 * and strips leading/trailing hyphens and dots (S3 rejects names that start or end with them).
 *
 * A value that still contains an unresolved CDK token — e.g. one built from `Stack.account`
 * or `Stack.region` on an environment-agnostic stack — is returned unchanged: `toLowerCase`
 * and `replace` would rewrite the token's placeholder text, which both corrupts the value at
 * deploy time and defeats `Token.isUnresolved` so CDK validates the mangled string as a literal
 * name. Callers must therefore keep any token in its own already-lowercase segment.
 */
function normalizeBucketName(name: string): string {
  if (cdk.Token.isUnresolved(name)) {
    return name;
  }
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
}
