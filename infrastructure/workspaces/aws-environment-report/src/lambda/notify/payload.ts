/**
 * Summary the BuildReport step returns (src/report-builder). Only aggregate
 * numbers: individual findings and resource names stay in the report.
 */
export interface ReportSummary {
  readonly targetMonth: string;
  readonly provisional: boolean;
  readonly reportLocation: string;
  readonly sources: { source: string; status: string; message?: string }[];
  readonly cost?: {
    total: number;
    previousTotal?: number | null;
    unallocated: number;
    currency: string;
  } | null;
  readonly findings: Record<string, number>;
  readonly diagram: { status: string; message?: string };
  readonly warnings: string[];
}

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

function money(n: number, currency: string): string {
  return `${currency === 'USD' ? '$' : ''}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Plain-text lines shared by both payloads. */
export function summaryLines(s: ReportSummary): { title: string; lines: string[] } {
  const title = `AWS environment report ${s.targetMonth}${s.provisional ? ' (provisional cost)' : ''}`;
  const lines: string[] = [];

  if (s.cost) {
    let costLine = `Cost: ${money(s.cost.total, s.cost.currency)}`;
    if (
      s.cost.previousTotal !== undefined &&
      s.cost.previousTotal !== null &&
      s.cost.previousTotal > 0
    ) {
      const delta = ((s.cost.total - s.cost.previousTotal) / s.cost.previousTotal) * 100;
      costLine += ` (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% vs previous month)`;
    }
    costLine += `, not attributable to a resource: ${money(s.cost.unallocated, s.cost.currency)}`;
    lines.push(costLine);
  } else {
    lines.push('Cost: not available');
  }

  lines.push(`Findings: ${SEVERITIES.map((sev) => `${sev} ${s.findings[sev] ?? 0}`).join(' / ')}`);
  lines.push(`Diagram: ${s.diagram.status}${s.diagram.message ? ` (${s.diagram.message})` : ''}`);

  const notOk = s.sources.filter((src) => src.status !== 'OK');
  lines.push(
    notOk.length === 0
      ? 'Data sources: all OK'
      : `Data sources not OK: ${notOk.map((src) => `${src.source}=${src.status}`).join(', ')}`
  );
  for (const w of s.warnings) {
    lines.push(`Warning: ${w}`);
  }
  lines.push(`Report: ${s.reportLocation}`);
  return { title, lines };
}

/** Slack incoming webhook (Block Kit, with `text` as the notification fallback). */
export function slackPayload(s: ReportSummary): unknown {
  const { title, lines } = summaryLines(s);
  return {
    text: title,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.map((l) => `• ${l}`).join('\n') } },
    ],
  };
}

/**
 * Teams Workflows ("When a Teams webhook request is received") expects a
 * message with an Adaptive Card attachment. The legacy Office 365 connector
 * Incoming Webhook is being retired, so it is not targeted here.
 */
export function teamsPayload(s: ReportSummary): unknown {
  const { title, lines } = summaryLines(s);
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
            ...lines.map((l) => ({ type: 'TextBlock', text: l, wrap: true, spacing: 'Small' })),
          ],
        },
      },
    ],
  };
}
