/**
 * Pure CUR 2.0 aggregation, kept free of the parquet reader so it can be unit
 * tested. Columns follow the CUR 2.0 schema (Data Exports, snake_case).
 */
export interface CurRow {
  readonly line_item_resource_id?: string | null;
  readonly line_item_product_code?: string | null;
  readonly line_item_unblended_cost?: number | string | null;
  readonly bill_invoice_id?: string | null;
}

export interface CurAggregate {
  rowCount: number;
  totalCost: number;
  allocatedCost: number;
  unallocatedCost: number;
  /** True as soon as one row carries an invoice ID (blank until the bill is final). */
  finalized: boolean;
  byResource: Record<string, { cost: number; productCode: string }>;
  byProduct: Record<string, number>;
}

export function emptyAggregate(): CurAggregate {
  return {
    rowCount: 0,
    totalCost: 0,
    allocatedCost: 0,
    unallocatedCost: 0,
    finalized: false,
    byResource: {},
    byProduct: {},
  };
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Adds rows into `agg` in place (files are streamed one at a time). */
export function addRows(agg: CurAggregate, rows: Iterable<CurRow>): CurAggregate {
  for (const row of rows) {
    agg.rowCount += 1;
    const cost = toNumber(row.line_item_unblended_cost);
    const product = row.line_item_product_code || 'Unknown';
    agg.totalCost += cost;
    agg.byProduct[product] = (agg.byProduct[product] ?? 0) + cost;
    if (row.bill_invoice_id) {
      agg.finalized = true;
    }
    const resourceId = row.line_item_resource_id;
    if (resourceId) {
      agg.allocatedCost += cost;
      const current = agg.byResource[resourceId];
      agg.byResource[resourceId] = {
        cost: (current?.cost ?? 0) + cost,
        productCode: current?.productCode ?? product,
      };
    } else {
      agg.unallocatedCost += cost;
    }
  }
  return agg;
}

/** Rounds every amount to cents so the raw JSON stays readable and stable. */
export function roundAggregate(agg: CurAggregate): CurAggregate {
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    ...agg,
    totalCost: r(agg.totalCost),
    allocatedCost: r(agg.allocatedCost),
    unallocatedCost: r(agg.unallocatedCost),
    byResource: Object.fromEntries(
      Object.entries(agg.byResource)
        .filter(([, v]) => Math.abs(v.cost) >= 0.005)
        .map(([k, v]) => [k, { ...v, cost: r(v.cost) }])
    ),
    byProduct: Object.fromEntries(Object.entries(agg.byProduct).map(([k, v]) => [k, r(v)])),
  };
}
