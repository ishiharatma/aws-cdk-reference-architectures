import { classifyError } from '../common/status';
import { assertMonth, curLocation, requireEnv } from '../common/env';
import { datePartsInZone, previousMonth } from '../common/month';
import { objectExists } from '../common/s3io';
import { isFinalized, listCurFiles } from '../common/cur';
import { CurState, decide } from './decide';

interface PreflightEvent {
  /** Execution input. Manual runs may pass { "targetMonth": "YYYY-MM", "force": true }. */
  readonly input?: { targetMonth?: string; force?: boolean };
}

export interface PreflightOutput {
  readonly action: 'RUN' | 'SKIP';
  readonly targetMonth: string;
  readonly provisional: boolean;
  readonly curState: CurState;
  readonly reason: string;
  readonly startedAt: string;
}

async function curState(month: string): Promise<CurState> {
  const loc = curLocation();
  if (!loc) {
    return 'NOT_CONFIGURED';
  }
  try {
    const keys = await listCurFiles(loc, month);
    if (keys.length === 0) {
      return 'NO_DATA';
    }
    return (await isFinalized(loc, keys)) ? 'FINALIZED' : 'NOT_FINALIZED';
  } catch (error) {
    console.error('CUR check failed', classifyError(error));
    return 'ERROR';
  }
}

export const handler = async (event: PreflightEvent): Promise<PreflightOutput> => {
  const timeZone = requireEnv('TIME_ZONE');
  const now = new Date();
  const targetMonth = assertMonth(event.input?.targetMonth ?? previousMonth(now, timeZone));
  const force = event.input?.force === true;

  const alreadyBuilt = await objectExists(
    requireEnv('BUCKET_NAME'),
    `reports/${targetMonth}/manifest.json`
  );
  const state: CurState = alreadyBuilt && !force ? 'UNCHECKED' : await curState(targetMonth);
  const decision = decide({
    alreadyBuilt,
    force,
    curState: state,
    dayOfMonth: datePartsInZone(now, timeZone).day,
    finalizeDeadlineDay: Number(requireEnv('FINALIZE_DEADLINE_DAY')),
  });

  const output: PreflightOutput = {
    action: decision.action,
    targetMonth,
    provisional: decision.provisional,
    curState: state,
    reason: decision.reason,
    startedAt: now.toISOString(),
  };
  console.log(JSON.stringify(output));
  return output;
};
