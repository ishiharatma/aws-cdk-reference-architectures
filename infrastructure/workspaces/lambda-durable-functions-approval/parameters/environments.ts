import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Durable workflow settings. `executionTimeoutDays` / `retentionDays` map to the function's
 * `DurableConfig`; changing them updates the function in place (no replacement).
 */
export interface WorkflowParams {
  /** Upper bound for one whole durable execution, in days (1-366). Must exceed the approval timeout. */
  readonly executionTimeoutDays: number;
  /** Days Lambda keeps the execution history after it closes (1-90). Billed as GB-month. */
  readonly retentionDays: number;
  /**
   * How long the workflow waits for an approver before marking the request EXPIRED, in minutes.
   * Minutes (not hours) so a deploy verification can exercise the EXPIRED branch in a few minutes.
   */
  readonly approvalTimeoutMinutes: number;
  /** Per-invocation timeout of the durable function in seconds. Waits do not count toward it. */
  readonly invocationTimeoutSeconds: number;
}

/** REST API stage throttling. */
export interface ApiThrottleParams {
  readonly rateLimit: number;
  readonly burstLimit: number;
}

/** Optional browser UI (Cognito + CloudFront) for demonstrating the workflow. */
export interface DemoWebUiParams {
  readonly enabled: boolean;
  /**
   * Cognito managed login domain prefix. Must be unique per Region across all AWS accounts and
   * must not contain "aws", "amazon" or "cognito". Defaults to `<project>-<env>-ldf-<account>`.
   */
  readonly cognitoDomainPrefix?: string;
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  readonly workflow: WorkflowParams;
  readonly apiThrottle: ApiThrottleParams;
  /** E-mail addresses subscribed to approval requests (optional; confirm the subscription mail). */
  readonly approverEmails?: string[];
  /** E-mail addresses subscribed to operational alerts (failed executions, DLQ messages). */
  readonly alertEmails?: string[];
  /** Demo web UI. Omit (or disable) for API-only use; the API itself is unchanged either way. */
  readonly demoWebUi?: DemoWebUiParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
