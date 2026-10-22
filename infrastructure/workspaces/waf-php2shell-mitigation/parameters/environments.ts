import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/** WAF action for one PHP2Shell mitigation rule. */
export type RuleAction = 'BLOCK' | 'COUNT';

/** CloudFront body inspection size limit (ALB is fixed at 8 KB and cannot be changed). */
export type CloudFrontBodyInspectionLimit = 'KB_16' | 'KB_32' | 'KB_48' | 'KB_64';

/**
 * Actions of the four custom rules from the AWS Security Blog post
 * "Using AWS WAF to apply mitigations for PHP2Shell RCE vulnerabilities".
 * The blog recommends starting every rule in COUNT and switching to BLOCK after
 * reviewing sampled requests.
 */
export interface Php2ShellRuleActions {
  /** POST + PHPSESSID + PHP_SESSION_UPLOAD_PROGRESS in the body (CVE-2026-109619 trigger). */
  readonly php2Shell: RuleAction;
  /** Any multipart/form-data request. Only safe to BLOCK when the app takes no uploads. */
  readonly blockMultipart: RuleAction;
  /** Body larger than `oversizeBodyBytes` (CVE-2026-109618 memory pressure). */
  readonly blockOversizeBody: RuleAction;
  /** More than `rateLimitPostsPerIp` POSTs per client IP in 60 seconds. */
  readonly rateLimitPosts: RuleAction;
}

/** Settings that differ per Web ACL (CloudFront vs ALB). */
export interface WebAclParams {
  readonly ruleActions: Php2ShellRuleActions;
  /**
   * Body size threshold of the oversize rule, in bytes (the blog uses 8192). Can exceed the
   * body inspection limit: with `oversizeHandling: MATCH` anything past the limit counts as oversize.
   */
  readonly oversizeBodyBytes: number;
}

/** Web ACL settings for both layers. */
export interface WafParams {
  readonly cloudFront: WebAclParams & {
    /** Body inspection size limit of the CloudFront Web ACL (default 16 KB, up to 64 KB). */
    readonly bodyInspectionLimit: CloudFrontBodyInspectionLimit;
    /** POST requests per client IP per 60 seconds (the blog uses 100). CloudFront only. */
    readonly rateLimitPostsPerIp: number;
  };
  /** ALB Web ACL. Its body inspection limit is fixed at 8 KB. */
  readonly alb: WebAclParams;
}

/** Lambda origin settings. */
export interface OriginParams {
  /** Lambda memory in MB. With `memory_limit = -1`, this is PHP's real memory ceiling. */
  readonly memorySize: number;
  readonly timeoutSeconds: number;
}

/** Switches used only by the verification (test-waf.sh). */
export interface VerificationParams {
  /**
   * Let the verification client IPs reach the ALB directly (security group + listener rule).
   * Needed only to compare the ALB's 8 KB inspection limit with CloudFront's; keep false in
   * production so the ALB answers CloudFront (X-Origin-Verify header) only.
   */
  readonly allowDirectAlbAccess: boolean;
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  readonly waf: WafParams;
  readonly origin: OriginParams;
  readonly verification: VerificationParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
