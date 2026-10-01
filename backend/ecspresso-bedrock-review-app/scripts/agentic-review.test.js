'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RISK_LEVELS,
  readDiff,
  buildPrompt,
  extractJson,
  reviewPerspective,
  aggregate,
  isBlocked,
  buildMetricData,
  PERSPECTIVES_BY_LANGUAGE,
} = require('./agentic-review');

const perspective = PERSPECTIVES_BY_LANGUAGE.en[0];

// Minimal Bedrock client stub: send() resolves or rejects as configured
const clientReturning = (text, usage = { inputTokens: 100, outputTokens: 50 }) => ({
  send: jest.fn().mockResolvedValue({ output: { message: { content: [{ text }] } }, usage }),
});
const clientFailing = (message) => ({ send: jest.fn().mockRejectedValue(new Error(message)) });

describe('extractJson', () => {
  test('parses plain JSON', () => {
    expect(extractJson('{"riskLevel":"low"}')).toEqual({ riskLevel: 'low' });
  });

  test('parses JSON wrapped in a code fence and surrounding text', () => {
    const text = 'Here is the result:\n```json\n{"riskLevel":"high"}\n```\nDone.';
    expect(extractJson(text)).toEqual({ riskLevel: 'high' });
  });

  test('throws when there is no JSON object', () => {
    expect(() => extractJson('no json here')).toThrow('no JSON object found');
  });

  test('throws on truncated JSON (output cut at maxTokens)', () => {
    expect(() => extractJson('{"riskLevel":"high","findings":[{"severity":"high",')).toThrow();
  });
});

describe('aggregate / isBlocked', () => {
  const result = (riskLevel) => ({ riskLevel });

  test('takes the highest risk level, not an average', () => {
    const { overallRiskLevel } = aggregate([result('low'), result('critical'), result('low'), result('medium')]);
    expect(overallRiskLevel).toBe('critical');
  });

  test('returns low for an empty result list', () => {
    expect(aggregate([]).overallRiskLevel).toBe('low');
  });

  test.each([
    ['low', 'high', false],
    ['medium', 'high', false],
    ['high', 'high', true],
    ['critical', 'high', true],
    ['medium', 'medium', true],
    ['low', 'low', true],
    ['high', 'critical', false],
  ])('isBlocked(%s, threshold=%s) is %s', (overall, threshold, expected) => {
    expect(isBlocked(overall, threshold)).toBe(expected);
  });

  test('RISK_LEVELS is ordered from lowest to highest', () => {
    expect(RISK_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
  });
});

describe('reviewPerspective', () => {
  const validJson = JSON.stringify({
    riskLevel: 'high',
    summary: 'hardcoded secret',
    findings: [{ severity: 'high', detail: 'API key in source' }],
  });

  test('returns the parsed result with token usage', async () => {
    const r = await reviewPerspective(clientReturning(validJson), 'model', perspective, 'diff', 'en');
    expect(r).toMatchObject({
      perspective: 'security',
      riskLevel: 'high',
      summary: 'hardcoded secret',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.error).toBeUndefined();
  });

  test('sends temperature 0 and maxTokens 1024', async () => {
    const client = clientReturning(validJson);
    await reviewPerspective(client, 'model-x', perspective, 'diff', 'en');
    const input = client.send.mock.calls[0][0].input;
    expect(input.modelId).toBe('model-x');
    expect(input.inferenceConfig).toEqual({ maxTokens: 1024, temperature: 0 });
  });

  test('a failed model call becomes MEDIUM with error=true', async () => {
    const r = await reviewPerspective(clientFailing('AccessDeniedException'), 'model', perspective, 'diff', 'en');
    expect(r.riskLevel).toBe('medium');
    expect(r.error).toBe(true);
    expect(r.summary).toContain('AccessDeniedException');
    expect(r.inputTokens).toBe(0);
  });

  test('unparsable output becomes MEDIUM with error=true', async () => {
    const r = await reviewPerspective(clientReturning('not json'), 'model', perspective, 'diff', 'en');
    expect(r.riskLevel).toBe('medium');
    expect(r.error).toBe(true);
  });

  test('an unexpected riskLevel is treated as a failure', async () => {
    const r = await reviewPerspective(clientReturning('{"riskLevel":"severe"}'), 'model', perspective, 'diff', 'en');
    expect(r.riskLevel).toBe('medium');
    expect(r.error).toBe(true);
  });

  test('the failure summary follows the review language', async () => {
    const ja = PERSPECTIVES_BY_LANGUAGE.ja[0];
    const r = await reviewPerspective(clientFailing('boom'), 'model', ja, 'diff', 'ja');
    expect(r.summary).toContain('要人手確認');
  });

  // Documents the known gap described in the article: when every perspective
  // fails, the aggregate is MEDIUM, which is below the default threshold.
  test('all perspectives failing stays below the default "high" threshold', async () => {
    const results = await Promise.all(
      PERSPECTIVES_BY_LANGUAGE.en.map((p) => reviewPerspective(clientFailing('denied'), 'model', p, 'diff', 'en'))
    );
    const { overallRiskLevel } = aggregate(results);
    expect(results.every((r) => r.error)).toBe(true);
    expect(overallRiskLevel).toBe('medium');
    expect(isBlocked(overallRiskLevel, 'high')).toBe(false);
  });
});

describe('readDiff', () => {
  let dir;
  const original = process.env.REVIEW_DIFF_FILE;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
    process.env.REVIEW_DIFF_FILE = path.join(dir, 'diff.patch');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (original === undefined) delete process.env.REVIEW_DIFF_FILE;
    else process.env.REVIEW_DIFF_FILE = original;
  });

  test('throws when the diff file is missing', () => {
    expect(() => readDiff()).toThrow('diff file not found');
  });

  test('returns null for a whitespace-only diff', () => {
    fs.writeFileSync(process.env.REVIEW_DIFF_FILE, '  \n\n');
    expect(readDiff()).toBeNull();
  });

  test('returns a small diff as is', () => {
    fs.writeFileSync(process.env.REVIEW_DIFF_FILE, 'diff --git a/x b/x\n');
    expect(readDiff()).toBe('diff --git a/x b/x\n');
  });

  test('truncates at 60,000 characters and marks it', () => {
    fs.writeFileSync(process.env.REVIEW_DIFF_FILE, 'a'.repeat(60001));
    const diff = readDiff();
    expect(diff).toBe(`${'a'.repeat(60000)}\n... (truncated)`);
  });

  test('keeps a diff of exactly 60,000 characters untouched', () => {
    fs.writeFileSync(process.env.REVIEW_DIFF_FILE, 'a'.repeat(60000));
    expect(readDiff()).toHaveLength(60000);
  });
});

describe('buildPrompt', () => {
  test('embeds the perspective, focus and diff between markers', () => {
    const prompt = buildPrompt(perspective, 'DIFF-BODY', 'en');
    expect(prompt).toContain(perspective.label);
    expect(prompt).toContain(perspective.focus);
    expect(prompt).toContain('--- diff start ---\nDIFF-BODY\n--- diff end ---');
  });

  test('switches instructions by language', () => {
    expect(buildPrompt(PERSPECTIVES_BY_LANGUAGE.ja[0], 'd', 'ja')).toContain('この差分のみを根拠に');
  });
});

describe('buildMetricData', () => {
  const report = {
    overallRiskLevel: 'high',
    results: [
      { perspective: 'security', riskLevel: 'high', latencyMs: 1200, inputTokens: 1500, outputTokens: 300 },
      { perspective: 'cost', riskLevel: 'medium', error: true, latencyMs: 400, inputTokens: 0, outputTokens: 0 },
    ],
  };
  const data = buildMetricData(report, { project: 'p', env: 'dev', blocked: true });
  const named = (name) => data.filter((d) => d.MetricName === name);

  test('emits 2 overall metrics plus 5 per perspective', () => {
    expect(data).toHaveLength(2 + 5 * report.results.length);
  });

  test('records the block decision and overall risk level', () => {
    expect(named('Blocked')[0].Value).toBe(1);
    const overall = named('OverallRiskLevel')[0];
    expect(overall.Dimensions).toContainEqual({ Name: 'RiskLevel', Value: 'high' });
  });

  test('flags only the failed perspective in PerspectiveError', () => {
    const errors = named('PerspectiveError');
    expect(errors.map((e) => e.Value)).toEqual([0, 1]);
  });

  test('carries tokens and latency per perspective', () => {
    expect(named('BedrockInputTokens')[0].Value).toBe(1500);
    expect(named('BedrockOutputTokens')[0].Value).toBe(300);
    expect(named('BedrockLatency')[0]).toMatchObject({ Unit: 'Milliseconds', Value: 1200 });
  });

  test('falls back to "unknown" dimensions and Blocked=0', () => {
    const d = buildMetricData(report, { blocked: false });
    expect(d.find((m) => m.MetricName === 'Blocked')).toMatchObject({
      Value: 0,
      Dimensions: [
        { Name: 'Project', Value: 'unknown' },
        { Name: 'Environment', Value: 'unknown' },
      ],
    });
  });
});
