import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { CurAggregate, CurRow, addRows, emptyAggregate } from './cur-aggregate';
import { getBytes, s3 } from './s3io';

export interface CurLocation {
  readonly bucket: string;
  readonly prefix: string;
  readonly exportName: string;
}

const COLUMNS = [
  'line_item_resource_id',
  'line_item_product_code',
  'line_item_unblended_cost',
  'bill_invoice_id',
];

/** `<prefix>/<exportName>/data/BILLING_PERIOD=YYYY-MM/` (prefix may be empty). */
export function billingPeriodPrefix(loc: CurLocation, month: string): string {
  const head = loc.prefix ? `${loc.prefix}/` : '';
  return `${head}${loc.exportName}/data/BILLING_PERIOD=${month}/`;
}

/**
 * Parquet files of one billing period. Requires the export to use
 * "overwrite existing report"; with "create new report" each refresh adds
 * another copy and the totals would be counted more than once.
 */
export async function listCurFiles(loc: CurLocation, month: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: loc.bucket,
        Prefix: billingPeriodPrefix(loc, month),
        ContinuationToken: token,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key?.endsWith('.parquet')) {
        keys.push(obj.Key);
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys.sort();
}

async function readParquetRows(bytes: Uint8Array, columns: string[]): Promise<CurRow[]> {
  // hyparquet is ESM-only; a dynamic import keeps this CommonJS module loadable.
  const { parquetReadObjects } = await import('hyparquet');
  const { compressors } = await import('hyparquet-compressors');
  const file = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return (await parquetReadObjects({ file, columns, compressors })) as CurRow[];
}

/** Reads every file of the month (one at a time, to bound memory) into one aggregate. */
export async function aggregateMonth(loc: CurLocation, keys: string[]): Promise<CurAggregate> {
  const agg = emptyAggregate();
  for (const key of keys) {
    addRows(agg, await readParquetRows(await getBytes(loc.bucket, key), COLUMNS));
  }
  return agg;
}

/** Finalization check only: stops at the first file that carries an invoice ID. */
export async function isFinalized(loc: CurLocation, keys: string[]): Promise<boolean> {
  for (const key of keys) {
    const rows = await readParquetRows(await getBytes(loc.bucket, key), ['bill_invoice_id']);
    if (rows.some((r) => r.bill_invoice_id)) {
      return true;
    }
  }
  return false;
}
