export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

export function targetRegions(): string[] {
  return requireEnv('TARGET_REGIONS')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');
}

/** CUR location, or undefined when the deployment has no cur parameters. */
export function curLocation(): { bucket: string; prefix: string; exportName: string } | undefined {
  const bucket = process.env.CUR_BUCKET ?? '';
  const exportName = process.env.CUR_EXPORT_NAME ?? '';
  if (bucket === '' || exportName === '') {
    return undefined;
  }
  return { bucket, prefix: process.env.CUR_PREFIX ?? '', exportName };
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertMonth(month: unknown): string {
  if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
    throw new Error(`targetMonth must be YYYY-MM, got ${JSON.stringify(month)}`);
  }
  return month;
}
