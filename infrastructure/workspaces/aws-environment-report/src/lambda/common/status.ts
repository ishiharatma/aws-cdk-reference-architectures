import { RegionResult, SourceStatus } from './types';

const DENIED_NAMES = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedOperation',
  'UnauthorizedException',
  'AuthorizationErrorException',
]);

/** Error names the services use for "not enabled / not subscribed" (verify against your account). */
const DISABLED_NAMES = new Set([
  'InvalidAccessException', // Security Hub: account not subscribed
  'ResourceNotFoundException',
  'NoSuchConfigurationRecorderException',
]);

export interface ClassifiedError {
  readonly status: SourceStatus;
  readonly message: string;
}

/** Maps an AWS SDK error to a status. DISABLED is checked before DENIED. */
export function classifyError(error: unknown): ClassifiedError {
  const e = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = e?.name ?? 'Error';
  const message = `${name}: ${e?.message ?? String(error)}`.slice(0, 500);
  if (DISABLED_NAMES.has(name)) {
    return { status: 'DISABLED', message };
  }
  if (DENIED_NAMES.has(name) || e?.$metadata?.httpStatusCode === 403) {
    return { status: 'DENIED', message };
  }
  return { status: 'ERROR', message };
}

const RANK: Record<SourceStatus, number> = { OK: 0, PARTIAL: 1, DISABLED: 2, DENIED: 3, ERROR: 4 };

/**
 * Rolls per-region statuses up into one source status: OK only when every
 * region is OK, the shared status when all regions agree, PARTIAL otherwise
 * (some regions usable, some not). No usable region yields the worst status.
 */
export function aggregateStatus(regions: RegionResult[]): SourceStatus {
  if (regions.length === 0) {
    return 'ERROR';
  }
  const statuses = new Set(regions.map((r) => r.status));
  if (statuses.size === 1) {
    return regions[0].status;
  }
  const usable = regions.some((r) => r.status === 'OK' || r.status === 'PARTIAL');
  if (usable) {
    return 'PARTIAL';
  }
  return regions.map((r) => r.status).reduce((a, b) => (RANK[a] >= RANK[b] ? a : b));
}
