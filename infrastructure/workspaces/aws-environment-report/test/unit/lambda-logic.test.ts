import { decide } from 'src/lambda/preflight/decide';
import { previousMonth, datePartsInZone } from 'src/lambda/common/month';
import { aggregateStatus, classifyError } from 'src/lambda/common/status';
import { addRows, emptyAggregate, roundAggregate } from 'src/lambda/common/cur-aggregate';
import { DEFAULT_WEBHOOK_SECRET, resolveWebhookTargets } from 'src/lambda/common/webhook-config';
import { recorderStatus } from 'src/lambda/collect-config/recorder';
import {
  dedupeFindings,
  extractResourceIds,
  guardDutySeverity,
} from 'src/lambda/collect-security/normalize';
import { slackPayload, summaryLines, teamsPayload, ReportSummary } from 'src/lambda/notify/payload';

describe('preflight decide', () => {
  const base = {
    alreadyBuilt: false,
    force: false,
    dayOfMonth: 3,
    finalizeDeadlineDay: 10,
  } as const;

  test('skips a month that is already built, unless forced', () => {
    expect(decide({ ...base, alreadyBuilt: true, curState: 'UNCHECKED' }).action).toBe('SKIP');
    expect(decide({ ...base, alreadyBuilt: true, force: true, curState: 'FINALIZED' }).action).toBe(
      'RUN'
    );
  });

  test('waits for CUR before the deadline and runs provisionally on it', () => {
    expect(decide({ ...base, curState: 'NOT_FINALIZED' })).toMatchObject({ action: 'SKIP' });
    expect(decide({ ...base, curState: 'NO_DATA', dayOfMonth: 10 })).toMatchObject({
      action: 'RUN',
      provisional: true,
    });
    expect(decide({ ...base, curState: 'FINALIZED' })).toMatchObject({
      action: 'RUN',
      provisional: false,
    });
  });

  test('runs immediately without CUR', () => {
    expect(decide({ ...base, curState: 'NOT_CONFIGURED' })).toMatchObject({
      action: 'RUN',
      provisional: false,
    });
  });
});

describe('month helpers', () => {
  test('previous month is computed in the configured time zone', () => {
    // 2026-10-31T16:00Z is already 2026-11-01 in Tokyo.
    expect(previousMonth(new Date('2026-10-31T16:00:00Z'), 'Asia/Tokyo')).toBe('2026-10');
    expect(previousMonth(new Date('2026-10-31T16:00:00Z'), 'UTC')).toBe('2026-09');
    expect(previousMonth(new Date('2026-01-05T00:00:00Z'), 'UTC')).toBe('2025-12');
    expect(datePartsInZone(new Date('2026-10-31T16:00:00Z'), 'Asia/Tokyo').day).toBe(1);
  });
});

describe('status helpers', () => {
  test('classifies not-enabled before access denied', () => {
    expect(
      classifyError({ name: 'InvalidAccessException', $metadata: { httpStatusCode: 403 } }).status
    ).toBe('DISABLED');
    expect(classifyError({ name: 'AccessDeniedException' }).status).toBe('DENIED');
    expect(classifyError({ name: 'ThrottlingException' }).status).toBe('ERROR');
  });

  test('aggregates per-region statuses', () => {
    expect(
      aggregateStatus([
        { region: 'a', status: 'OK' },
        { region: 'b', status: 'OK' },
      ])
    ).toBe('OK');
    expect(
      aggregateStatus([
        { region: 'a', status: 'OK' },
        { region: 'b', status: 'DISABLED' },
      ])
    ).toBe('PARTIAL');
    expect(
      aggregateStatus([
        { region: 'a', status: 'DISABLED' },
        { region: 'b', status: 'DENIED' },
      ])
    ).toBe('DENIED');
    expect(aggregateStatus([])).toBe('ERROR');
  });
});

describe('Config recorder status', () => {
  test('distinguishes disabled, partial and full recording', () => {
    expect(recorderStatus([], []).status).toBe('DISABLED');
    expect(
      recorderStatus(
        [{ name: 'default', recordingGroup: { allSupported: true } }],
        [{ name: 'default', recording: false }]
      ).status
    ).toBe('DISABLED');
    expect(
      recorderStatus(
        [{ name: 'default', recordingGroup: { allSupported: true } }],
        [{ name: 'default', recording: true }]
      ).status
    ).toBe('OK');
    expect(
      recorderStatus(
        [
          {
            name: 'default',
            recordingGroup: { recordingStrategy: { useOnly: 'EXCLUSION_BY_RESOURCE_TYPES' } },
          },
        ],
        [{ name: 'default', recording: true }]
      ).status
    ).toBe('PARTIAL');
  });
});

describe('CUR aggregation', () => {
  test('splits allocated and unallocated cost and detects finalization', () => {
    const agg = addRows(emptyAggregate(), [
      {
        line_item_resource_id: 'i-1',
        line_item_product_code: 'AmazonEC2',
        line_item_unblended_cost: 10.004,
      },
      {
        line_item_resource_id: 'i-1',
        line_item_product_code: 'AmazonEC2',
        line_item_unblended_cost: '5',
      },
      {
        line_item_resource_id: '',
        line_item_product_code: 'AWSSupport',
        line_item_unblended_cost: 3,
      },
    ]);
    expect(agg.finalized).toBe(false);
    const r = roundAggregate(agg);
    expect(r).toMatchObject({ totalCost: 18, allocatedCost: 15, unallocatedCost: 3 });
    expect(r.byResource['i-1'].cost).toBe(15);
    addRows(agg, [
      { line_item_resource_id: 'x', line_item_unblended_cost: 0, bill_invoice_id: 'INV-1' },
    ]);
    expect(agg.finalized).toBe(true);
  });
});

describe('webhook secret handling', () => {
  test('sends nothing while the secret holds the default', () => {
    expect(resolveWebhookTargets(DEFAULT_WEBHOOK_SECRET).targets).toEqual([]);
  });

  test('skips entries that are not https URLs', () => {
    const { targets, skipped } = resolveWebhookTargets(
      JSON.stringify({
        webhooks: [
          { type: 'slack', url: 'https://hooks.slack.com/services/T/B/x' },
          { type: 'teams', url: 'REPLACE_WITH_WEBHOOK_URL' },
          { type: 'teams', url: 'http://insecure.example.com/hook' },
          { type: 'discord', url: 'https://example.com' },
        ],
      })
    );
    expect(targets).toEqual([{ type: 'slack', url: 'https://hooks.slack.com/services/T/B/x' }]);
    expect(skipped).toHaveLength(3);
    expect(skipped.join(' ')).not.toContain('insecure.example.com'); // URLs are never echoed
  });

  test('handles unparsable secrets', () => {
    expect(resolveWebhookTargets('not json').targets).toEqual([]);
    expect(resolveWebhookTargets('{"webhooks": 1}').targets).toEqual([]);
  });
});

describe('security normalization', () => {
  test('maps GuardDuty severity ranges', () => {
    expect([9.5, 7, 4, 1, 0].map(guardDutySeverity)).toEqual([
      'CRITICAL',
      'HIGH',
      'MEDIUM',
      'LOW',
      'INFORMATIONAL',
    ]);
  });

  test('extracts ARNs and IDs from nested resource details', () => {
    const ids = extractResourceIds({
      InstanceDetails: { InstanceId: 'i-0123456789abcdef0', Tags: [{ Value: 'x' }] },
      S3: [{ Arn: 'arn:aws:s3:::b' }],
    });
    expect(ids.sort()).toEqual(['arn:aws:s3:::b', 'i-0123456789abcdef0']);
  });

  test('deduplicates access analyzer findings repeated per region', () => {
    const f = {
      source: 'access-analyzer' as const,
      severity: 'HIGH' as const,
      title: 't',
      resourceIds: ['arn:aws:iam::1:role/r'],
    };
    expect(
      dedupeFindings([
        { ...f, region: 'us-east-1' },
        { ...f, region: 'ap-northeast-1' },
      ])
    ).toHaveLength(1);
  });
});

describe('notification payloads', () => {
  const summary: ReportSummary = {
    targetMonth: '2026-09',
    provisional: true,
    reportLocation: 's3://bucket/reports/2026-09/index.html',
    sources: [
      { source: 'config', status: 'OK' },
      { source: 'inspector', status: 'DISABLED' },
    ],
    cost: { total: 1100, previousTotal: 1000, unallocated: 50, currency: 'USD' },
    findings: { CRITICAL: 1, HIGH: 2 },
    diagram: { status: 'OK' },
    warnings: [],
  };

  test('summarizes cost delta, findings and non-OK sources', () => {
    const { title, lines } = summaryLines(summary);
    expect(title).toContain('provisional');
    expect(lines.join('\n')).toContain('+10.0% vs previous month');
    expect(lines.join('\n')).toContain('CRITICAL 1 / HIGH 2 / MEDIUM 0 / LOW 0');
    expect(lines.join('\n')).toContain('inspector=DISABLED');
  });

  test('builds Slack and Teams (Adaptive Card) bodies', () => {
    expect(slackPayload(summary)).toHaveProperty('blocks');
    const teams = teamsPayload(summary) as { attachments: { contentType: string }[] };
    expect(teams.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
  });
});
