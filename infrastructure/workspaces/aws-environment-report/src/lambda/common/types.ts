/**
 * Status every collector reports per source (and per region where the source
 * is regional). DENIED is kept apart from DISABLED on purpose: a missing IAM
 * permission must not read as "the service is turned off".
 */
export type SourceStatus = 'OK' | 'PARTIAL' | 'DISABLED' | 'DENIED' | 'ERROR';

export interface RegionResult {
  readonly region: string;
  readonly status: SourceStatus;
  readonly message?: string;
}

export interface SourceResult {
  readonly source: string;
  readonly status: SourceStatus;
  readonly message?: string;
  readonly regions?: RegionResult[];
  /** S3 key of the raw output, when anything was written. */
  readonly s3Key?: string;
  readonly itemCount?: number;
}

/** What a collector Lambda returns to Step Functions (kept small: 256 KB state limit). */
export interface CollectorOutput {
  readonly collector: string;
  readonly results: SourceResult[];
}

export interface CollectorEvent {
  readonly targetMonth: string;
}

/** Severity labels used across all security sources. */
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL';
