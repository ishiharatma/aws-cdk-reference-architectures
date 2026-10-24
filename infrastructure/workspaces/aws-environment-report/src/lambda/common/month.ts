/** Year, month and day of `now` in the given IANA time zone. */
export function datePartsInZone(
  now: Date,
  timeZone: string
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** The calendar month before `now` in the given time zone, as YYYY-MM. */
export function previousMonth(now: Date, timeZone: string): string {
  const { year, month } = datePartsInZone(now, timeZone);
  const y = month === 1 ? year - 1 : year;
  const m = month === 1 ? 12 : month - 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}
