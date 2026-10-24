export type CurState =
  'UNCHECKED' | 'NOT_CONFIGURED' | 'NO_DATA' | 'NOT_FINALIZED' | 'FINALIZED' | 'ERROR';

export interface DecisionInput {
  readonly alreadyBuilt: boolean;
  readonly force: boolean;
  readonly curState: CurState;
  readonly dayOfMonth: number;
  readonly finalizeDeadlineDay: number;
}

export interface Decision {
  readonly action: 'RUN' | 'SKIP';
  readonly provisional: boolean;
  readonly reason: string;
}

/**
 * Whether today's run builds the report.
 *
 * - A month is built once (reports/YYYY-MM/manifest.json exists -> SKIP).
 * - With CUR configured, wait for the invoice to be final; from the deadline
 *   day on, build anyway and mark the cost figures provisional.
 * - Without CUR there is nothing to wait for.
 * - `force` (manual execution) builds now, provisional if CUR is not final.
 */
export function decide(input: DecisionInput): Decision {
  if (input.alreadyBuilt && !input.force) {
    return { action: 'SKIP', provisional: false, reason: 'report for this month already exists' };
  }
  if (input.curState === 'NOT_CONFIGURED') {
    return {
      action: 'RUN',
      provisional: false,
      reason: 'CUR not configured; no cost data to wait for',
    };
  }
  if (input.curState === 'FINALIZED') {
    return { action: 'RUN', provisional: false, reason: 'CUR finalized' };
  }
  if (input.force) {
    return { action: 'RUN', provisional: true, reason: `forced run; CUR state ${input.curState}` };
  }
  if (input.dayOfMonth >= input.finalizeDeadlineDay) {
    return {
      action: 'RUN',
      provisional: true,
      reason: `deadline day reached; CUR state ${input.curState}`,
    };
  }
  return {
    action: 'SKIP',
    provisional: false,
    reason: `waiting for CUR (state ${input.curState})`,
  };
}
