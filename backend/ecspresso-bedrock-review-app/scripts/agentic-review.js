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
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

const PERSPECTIVES = [
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
];

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

function buildPrompt(perspective, diff) {
  return `You are a code reviewer specialized in the ${perspective.label} perspective.
What to focus on: ${perspective.focus}

Below is the git diff of a pull request. Base your review only on this diff.
Do not raise risks that are generic or speculative and not evidenced by the diff itself.

--- diff start ---
${diff}
--- diff end ---

Respond with the following JSON only, and nothing else:
{
  "riskLevel": "low" | "medium" | "high" | "critical",
  "summary": "one-sentence overall review summary, in English",
  "findings": [
    { "severity": "low" | "medium" | "high" | "critical", "detail": "finding detail, in English" }
  ]
}
If there is nothing to flag, return an empty findings array and riskLevel "low".`;
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

async function reviewPerspective(client, modelId, perspective, diff) {
  const command = new ConverseCommand({
    modelId,
    messages: [{ role: 'user', content: [{ text: buildPrompt(perspective, diff) }] }],
    inferenceConfig: { maxTokens: 1024, temperature: 0 },
  });

  try {
    const response = await client.send(command);
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
    };
  } catch (err) {
    // Surface a perspective whose model call or parse failed as "medium" risk:
    // one failed perspective shouldn't unconditionally halt the whole pipeline,
    // but it also shouldn't be swallowed silently.
    return {
      perspective: perspective.id,
      label: perspective.label,
      riskLevel: 'medium',
      summary: `Review call failed and needs manual follow-up: ${err.message}`,
      findings: [],
      error: true,
    };
  }
}

function aggregate(results) {
  const overallRiskLevel = results.reduce((max, r) => {
    return RISK_LEVELS.indexOf(r.riskLevel) > RISK_LEVELS.indexOf(max) ? r.riskLevel : max;
  }, 'low');
  return { overallRiskLevel, results };
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

  console.log(`Reviewing diff with model=${modelId} region=${region} across ${PERSPECTIVES.length} perspectives...`);
  const results = await Promise.all(
    PERSPECTIVES.map((perspective) => reviewPerspective(client, modelId, perspective, diff))
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

  if (RISK_LEVELS.indexOf(report.overallRiskLevel) >= RISK_LEVELS.indexOf(threshold)) {
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
