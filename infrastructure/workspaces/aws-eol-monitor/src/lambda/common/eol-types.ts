/** Kind of change a diff entry represents, relative to the last recorded state. */
export type DiffType = 'NEW' | 'STATUS_CHANGED' | 'UPCOMING_EOL';

/** One (serviceCode, version) pair whose state changed since the last run. */
export interface DiffEntry {
  readonly type: DiffType;
  readonly serviceCode: string;
  readonly serviceName: string;
  readonly version: string;
  readonly status: string;
  readonly standardSupportEnd: string | null;
  readonly previousStatus?: string;
  readonly daysUntilEol?: number;
  readonly sourceUrl?: string;
}

/** Output of the fetch-eol-diff Lambda; input to the generate-report Lambda. */
export interface FetchEolDiffResult {
  readonly checkedAt: string;
  readonly datasetLastUpdated: string;
  readonly totalServices: number;
  readonly totalVersionsTracked: number;
  readonly diffCount: number;
  readonly diffs: DiffEntry[];
}
