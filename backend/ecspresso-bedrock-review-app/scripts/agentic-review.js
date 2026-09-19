#!/usr/bin/env node
/**
 * Agentic code review powered by Amazon Bedrock.
 *
 * Sends the target git diff to a Bedrock model in pseudo-parallel, once per
 * review perspective (security / infra / quality / cost), then aggregates
 * each perspective's findings and risk level. Exits non-zero when the
 * aggregated risk level is at or above RISK_THRESHOLD, stopping CodeBuild
 * (and therefore the pipeline).
 *
 * Environment variables:
 *   BEDROCK_MODEL_ID     Bedrock model ID used for the review (required; swap it at the call site)
 *   AWS_REGION            Region to call Bedrock in (default: CodeBuild's AWS_DEFAULT_REGION)
 *   REVIEW_DIFF_FILE       Path to the diff file to review (default: diff.patch)
 *   RISK_THRESHOLD         Minimum risk level that blocks the build: low|medium|high|critical (default: high)
 *   REVIEW_REPORT_FILE     Where to write the report (default: agentic-review-report.json)
 *   REVIEW_LANGUAGE        Language the model writes its summary/findings in: en|ja (default: en)
 *   REVIEW_NOTIFICATION_ENABLED   Publish the summary to SNS: true|false (default: false)
 *   REVIEW_NOTIFICATION_TOPIC_ARN  SNS topic ARN to publish to (required when the above is true)
 *   METRICS_NAMESPACE              CloudWatch namespace to publish metrics to (default: AgenticReview)
 *   PROJECT / ENV                  Included in the notification subject and metric dimensions, if set
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const SUPPORTED_LANGUAGES = ['en', 'ja'];

const PERSPECTIVES_BY_LANGUAGE = {
  en: [
    {
      id: 'security',
      label: 'Security',
      focus:
        'missing authentication/authorization, hardcoded secrets/credentials, injection, ' +
        'unsafe new dependencies, missing input validation',
    },
    {
      id: 'infra',
      label: 'Infra/Ops',
      focus:
        'overly broad IAM permissions, misconfigured ECS/container settings, missing observability ' +
        '(logging, health checks), scalability or graceful-shutdown issues',
    },
    {
      id: 'quality',
      label: 'Code quality',
      focus: 'readability, missing error handling, insufficient tests, obvious bugs or logic errors',
    },
    {
      id: 'cost',
      label: 'Cost',
      focus: 'over-provisioned resources, unnecessary external API calls, cost from inefficient loops/queries',
    },
  ],
  ja: [
    {
      id: 'security',
      label: 'セキュリティ',
      focus:
        '認証・認可の欠落、シークレット/認証情報のハードコード、インジェクション、' +
        '安全でない依存関係の追加、入力バリデーションの欠如',
    },
    {
      id: 'infra',
      label: 'インフラ/運用',
      focus:
        'IAM権限の過剰付与、ECS/コンテナ設定の不備、可観測性（ログ・ヘルスチェック）の欠落、' +
        'スケーラビリティやグレースフルシャットダウンの問題',
    },
    {
      id: 'quality',
      label: 'コード品質',
      focus: '可読性、エラーハンドリングの欠如、テスト不足、明らかなバグやロジック誤り',
    },
    {
      id: 'cost',
      label: 'コスト',
      focus: '過剰なリソース確保、不要な外部API呼び出しの増加、非効率なループ/クエリによるコスト増',
    },
  ],
};

const PROMPT_TEXT_BY_LANGUAGE = {
  en: {
    role: (label) => `You are a code reviewer specialized in the ${label} perspective.`,
    focusLabel: 'What to focus on:',
    diffInstruction:
      'Below is the git diff of a pull request. Base your review only on this diff.\n' +
      'Do not raise risks that are generic or speculative and not evidenced by the diff itself.',
    jsonInstruction: 'Respond with the following JSON only, and nothing else:',
    summaryField: 'one-sentence overall review summary, in English',
    detailField: 'finding detail, in English',
    emptyInstruction: 'If there is nothing to flag, return an empty findings array and riskLevel "low".',
    reviewFailedSummary: (message) => `Review call failed and needs manual follow-up: ${message}`,
  },
  ja: {
    role: (label) => `あなたは${label}の観点に特化したコードレビュアーです。`,
    focusLabel: '着目すべき点:',
    diffInstruction:
      '以下は Pull Request の git diff です。この差分のみを根拠にレビューしてください。\n' +
      '差分に含まれない一般論や推測でのリスク評価はしないでください。',
    jsonInstruction: '出力は次の JSON 形式のみとし、それ以外のテキストは一切出力しないでください。',
    summaryField: '一文でのレビュー総評（日本語）',
    detailField: '指摘内容（日本語）',
    emptyInstruction: '指摘がない場合は findings を空配列にし、riskLevel は "low" としてください。',
    reviewFailedSummary: (message) => `レビュー呼び出しに失敗したため要人手確認: ${message}`,
  },
};

function readDiff() {
  const diffFile = process.env.REVIEW_DIFF_FILE || 'diff.patch';
  if (!fs.existsSync(diffFile)) {
    throw new Error(`diff file not found: ${diffFile}`);
  }
  const diff = fs.readFileSync(diffFile, 'utf8');
  if (!diff.trim()) {
    return null;
  }
  // Cap the size so a huge diff doesn't blow up the token count
  const MAX_CHARS = 60000;
  return diff.length > MAX_CHARS ? `${diff.slice(0, MAX_CHARS)}\n... (truncated)` : diff;
}

function buildPrompt(perspective, diff, lang) {
  const t = PROMPT_TEXT_BY_LANGUAGE[lang];
  return `${t.role(perspective.label)}
${t.focusLabel} ${perspective.focus}

${t.diffInstruction}

--- diff start ---
${diff}
--- diff end ---

${t.jsonInstruction}
{
  "riskLevel": "low" | "medium" | "high" | "critical",
  "summary": "${t.summaryField}",
  "findings": [
    { "severity": "low" | "medium" | "high" | "critical", "detail": "${t.detailField}" }
  ]
}
${t.emptyInstruction}`;
}

function extractJson(text) {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('no JSON object found in model output');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

async function reviewPerspective(client, modelId, perspective, diff, lang) {
  const command = new ConverseCommand({
    modelId,
    messages: [{ role: 'user', content: [{ text: buildPrompt(perspective, diff, lang) }] }],
    inferenceConfig: { maxTokens: 1024, temperature: 0 },
  });

  const startedAt = Date.now();
  try {
    const response = await client.send(command);
    const latencyMs = Date.now() - startedAt;
    const text = response.output?.message?.content?.map((c) => c.text || '').join('') ?? '';
    const parsed = extractJson(text);
    if (!RISK_LEVELS.includes(parsed.riskLevel)) {
      throw new Error(`unexpected riskLevel: ${parsed.riskLevel}`);
    }
    return {
      perspective: perspective.id,
      label: perspective.label,
      riskLevel: parsed.riskLevel,
      summary: parsed.summary ?? '',
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      latencyMs,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    };
  } catch (err) {
    // Surface a perspective whose model call or parse failed as "medium" risk:
    // one failed perspective shouldn't unconditionally halt the whole pipeline,
    // but it also shouldn't be swallowed silently.
    return {
      perspective: perspective.id,
      label: perspective.label,
      riskLevel: 'medium',
      summary: PROMPT_TEXT_BY_LANGUAGE[lang].reviewFailedSummary(err.message),
      findings: [],
      error: true,
      latencyMs: Date.now() - startedAt,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

function aggregate(results) {
  const overallRiskLevel = results.reduce((max, r) => {
    return RISK_LEVELS.indexOf(r.riskLevel) > RISK_LEVELS.indexOf(max) ? r.riskLevel : max;
  }, 'low');
  return { overallRiskLevel, results };
}

function formatNotificationMessage(report, { project, env, threshold }) {
  const lines = [
    `Project: ${project ?? 'unknown'}`,
    `Environment: ${env ?? 'unknown'}`,
    `Overall risk level: ${report.overallRiskLevel.toUpperCase()} (threshold: ${threshold.toUpperCase()})`,
    '',
  ];
  for (const r of report.results) {
    lines.push(`[${r.riskLevel.toUpperCase()}] ${r.label}: ${r.summary}`);
    for (const f of r.findings) {
      lines.push(`  - (${f.severity}) ${f.detail}`);
    }
  }
  return lines.join('\n');
}

// This is the only way a human sees the review result before the Approve
// stage: ManualApprovalAction's additionalInformation is a static string
// baked into the CloudFormation template and can't carry a per-run value.
// A notification failure here must never fail the build -- it's a
// convenience layer on top of the CodeBuild logs and report artifact, not
// the source of truth for the risk decision.
async function publishReviewNotification(report, { region, topicArn, project, env, threshold }) {
  const client = new SNSClient({ region });
  const subject = `[${project ?? 'project'}][${env ?? 'env'}] Agentic Review: ${report.overallRiskLevel.toUpperCase()} risk`.slice(
    0,
    100
  );
  const message = formatNotificationMessage(report, { project, env, threshold });
  await client.send(new PublishCommand({ TopicArn: topicArn, Subject: subject, Message: message }));
}

// Effect-measurement data: how often the review blocks, how it splits across
// risk levels per perspective, how reliable the Bedrock calls are, and what
// they cost (tokens) and how long they take (latency). This is what turns
// "we added an AI review gate" into something you can actually evaluate over
// time instead of just trusting anecdotally.
function buildMetricData(report, { project, env, blocked }) {
  const dimensions = [
    { Name: 'Project', Value: project ?? 'unknown' },
    { Name: 'Environment', Value: env ?? 'unknown' },
  ];
  const now = new Date();
  const metricData = [
    {
      MetricName: 'OverallRiskLevel',
      Dimensions: [...dimensions, { Name: 'RiskLevel', Value: report.overallRiskLevel }],
      Timestamp: now,
      Unit: 'Count',
      Value: 1,
    },
    {
      MetricName: 'Blocked',
      Dimensions: dimensions,
      Timestamp: now,
      Unit: 'Count',
      Value: blocked ? 1 : 0,
    },
  ];
  for (const r of report.results) {
    const perspectiveDimensions = [...dimensions, { Name: 'Perspective', Value: r.perspective }];
    metricData.push(
      {
        MetricName: 'PerspectiveRiskLevel',
        Dimensions: [...perspectiveDimensions, { Name: 'RiskLevel', Value: r.riskLevel }],
        Timestamp: now,
        Unit: 'Count',
        Value: 1,
      },
      {
        MetricName: 'PerspectiveError',
        Dimensions: perspectiveDimensions,
        Timestamp: now,
        Unit: 'Count',
        Value: r.error ? 1 : 0,
      },
      {
        MetricName: 'BedrockLatency',
        Dimensions: perspectiveDimensions,
        Timestamp: now,
        Unit: 'Milliseconds',
        Value: r.latencyMs ?? 0,
      },
      {
        MetricName: 'BedrockInputTokens',
        Dimensions: perspectiveDimensions,
        Timestamp: now,
        Unit: 'Count',
        Value: r.inputTokens ?? 0,
      },
      {
        MetricName: 'BedrockOutputTokens',
        Dimensions: perspectiveDimensions,
        Timestamp: now,
        Unit: 'Count',
        Value: r.outputTokens ?? 0,
      }
    );
  }
  return metricData;
}

// A metrics-publish failure must never fail the build, same rationale as
// publishReviewNotification -- this is an observability layer, not the
// source of truth for the risk decision.
async function publishMetrics(report, { region, namespace, project, env, blocked }) {
  const client = new CloudWatchClient({ region });
  const metricData = buildMetricData(report, { project, env, blocked });
  // PutMetricData accepts up to 1000 data points per call; this review
  // never produces more than a few dozen, so one call is always enough.
  await client.send(new PutMetricDataCommand({ Namespace: namespace, MetricData: metricData }));
}

async function main() {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw new Error('BEDROCK_MODEL_ID is required');
  }
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  const threshold = process.env.RISK_THRESHOLD || 'high';
  if (!RISK_LEVELS.includes(threshold)) {
    throw new Error(`invalid RISK_THRESHOLD: ${threshold}`);
  }
  const lang = process.env.REVIEW_LANGUAGE || 'en';
  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    throw new Error(`invalid REVIEW_LANGUAGE: ${lang} (supported: ${SUPPORTED_LANGUAGES.join(', ')})`);
  }
  const perspectives = PERSPECTIVES_BY_LANGUAGE[lang];
  const reportFile = process.env.REVIEW_REPORT_FILE || 'agentic-review-report.json';

  const diff = readDiff();
  if (!diff) {
    console.log('No diff to review (empty diff). Skipping agentic review.');
    fs.writeFileSync(
      reportFile,
      JSON.stringify({ overallRiskLevel: 'low', results: [], skipped: true }, null, 2)
    );
    return;
  }

  const client = new BedrockRuntimeClient({ region });

  console.log(
    `Reviewing diff with model=${modelId} region=${region} language=${lang} across ${perspectives.length} perspectives...`
  );
  const results = await Promise.all(
    perspectives.map((perspective) => reviewPerspective(client, modelId, perspective, diff, lang))
  );

  const report = aggregate(results);
  fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  console.log('=== Agentic Code Review Report ===');
  for (const r of results) {
    console.log(`[${r.riskLevel.toUpperCase()}] ${r.label}: ${r.summary}`);
    for (const f of r.findings) {
      console.log(`  - (${f.severity}) ${f.detail}`);
    }
  }
  console.log(`Overall risk level: ${report.overallRiskLevel.toUpperCase()} (threshold: ${threshold.toUpperCase()})`);

  const blocked = RISK_LEVELS.indexOf(report.overallRiskLevel) >= RISK_LEVELS.indexOf(threshold);

  const notificationEnabled = process.env.REVIEW_NOTIFICATION_ENABLED === 'true';
  if (notificationEnabled) {
    const topicArn = process.env.REVIEW_NOTIFICATION_TOPIC_ARN;
    if (!topicArn) {
      console.error('REVIEW_NOTIFICATION_ENABLED is true but REVIEW_NOTIFICATION_TOPIC_ARN is not set; skipping notification.');
    } else {
      try {
        await publishReviewNotification(report, {
          region,
          topicArn,
          project: process.env.PROJECT,
          env: process.env.ENV,
          threshold,
        });
        console.log(`Published review summary to ${topicArn}`);
      } catch (err) {
        console.error('Failed to publish review summary notification (continuing):', err);
      }
    }
  }

  try {
    await publishMetrics(report, {
      region,
      namespace: process.env.METRICS_NAMESPACE || 'AgenticReview',
      project: process.env.PROJECT,
      env: process.env.ENV,
      blocked,
    });
    console.log('Published CloudWatch metrics.');
  } catch (err) {
    console.error('Failed to publish CloudWatch metrics (continuing):', err);
  }

  if (blocked) {
    console.error(
      `Agentic review blocked the pipeline: risk level "${report.overallRiskLevel}" >= threshold "${threshold}".`
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Agentic review failed:', err);
  process.exitCode = 1;
});
