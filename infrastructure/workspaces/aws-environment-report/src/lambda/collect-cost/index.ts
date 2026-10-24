import { classifyError } from '../common/status';
import { assertMonth, curLocation, requireEnv } from '../common/env';
import { putJson, rawKey } from '../common/s3io';
import { aggregateMonth, billingPeriodPrefix, listCurFiles } from '../common/cur';
import { roundAggregate } from '../common/cur-aggregate';
import { CollectorEvent, CollectorOutput, SourceResult } from '../common/types';

/**
 * Cost per resource from CUR 2.0 (unblended cost). CUR is account-wide, so
 * this collector is not per region.
 */
export const handler = async (event: CollectorEvent): Promise<CollectorOutput> => {
  const month = assertMonth(event.targetMonth);
  const loc = curLocation();
  const done = (result: SourceResult): CollectorOutput => ({
    collector: 'cost',
    results: [result],
  });

  if (!loc) {
    return done({ source: 'cur', status: 'DISABLED', message: 'cur parameters are not set' });
  }
  try {
    const keys = await listCurFiles(loc, month);
    if (keys.length === 0) {
      return done({
        source: 'cur',
        status: 'DISABLED',
        message: `no parquet files under s3://${loc.bucket}/${billingPeriodPrefix(loc, month)}`,
      });
    }
    const agg = roundAggregate(await aggregateMonth(loc, keys));
    const key = rawKey(month, 'cost');
    await putJson(requireEnv('BUCKET_NAME'), key, {
      collectedAt: new Date().toISOString(),
      basis: 'unblended',
      files: keys.length,
      ...agg,
    });
    return done({
      source: 'cur',
      status: 'OK',
      s3Key: key,
      itemCount: Object.keys(agg.byResource).length,
    });
  } catch (error) {
    return done({ source: 'cur', ...classifyError(error) });
  }
};
