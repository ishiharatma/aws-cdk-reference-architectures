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
  /** How long the workflow waits for an approver before marking the request EXPIRED. */
  readonly approvalTimeoutHours: number;
  /** Per-invocation timeout of the durable function in seconds. Waits do not count toward it. */
  readonly invocationTimeoutSeconds: number;
}

/** REST API stage throttling. */
export interface ApiThrottleParams {
  readonly rateLimit: number;
  readonly burstLimit: number;
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
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
