#!/usr/bin/env node
/**
 * Amazon Bedrock を使った Agentic Code Review。
 *
 * 対象の git diff を複数の専門観点（security / infra / quality / cost）ごとに
 * 疑似並列で Bedrock モデルへ投げ、各観点の指摘とリスクレベルを集約する。
 * 集約結果が RISK_THRESHOLD 以上であれば非ゼロ終了し、CodeBuild（≒パイプライン）を止める。
 *
 * 環境変数:
 *   BEDROCK_MODEL_ID   レビューに使う Bedrock モデル ID（必須。呼び出し元で切り替える）
 *   AWS_REGION          Bedrock 呼び出しリージョン（既定: CodeBuild の AWS_DEFAULT_REGION）
 *   REVIEW_DIFF_FILE     レビュー対象の diff ファイルパス（既定: diff.patch）
 *   RISK_THRESHOLD       ブロックする最小リスクレベル low|medium|high|critical（既定: high）
 *   REVIEW_REPORT_FILE   結果レポートの出力先（既定: agentic-review-report.json）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

const PERSPECTIVES = [
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
  // 巨大な diff でトークン数が膨らみ過ぎないよう上限を設ける
  const MAX_CHARS = 60000;
  return diff.length > MAX_CHARS ? `${diff.slice(0, MAX_CHARS)}\n... (truncated)` : diff;
}

function buildPrompt(perspective, diff) {
  return `あなたは${perspective.label}の観点に特化したコードレビュアーです。
着目すべき点: ${perspective.focus}

以下は Pull Request の git diff です。この差分のみを根拠にレビューしてください。
差分に含まれない一般論や推測でのリスク評価はしないでください。

--- diff start ---
${diff}
--- diff end ---

出力は次の JSON 形式のみとし、それ以外のテキストは一切出力しないでください。
{
  "riskLevel": "low" | "medium" | "high" | "critical",
  "summary": "一文でのレビュー総評（日本語）",
  "findings": [
    { "severity": "low" | "medium" | "high" | "critical", "detail": "指摘内容（日本語）" }
  ]
}
指摘がない場合は findings を空配列にし、riskLevel は "low" としてください。`;
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
    // モデル呼び出し・パースに失敗した観点は "medium" 扱いで可視化し、
    // 1観点の失敗でパイプライン全体を無条件停止させない一方、黙って握り潰さない。
    return {
      perspective: perspective.id,
      label: perspective.label,
      riskLevel: 'medium',
      summary: `レビュー呼び出しに失敗したため要人手確認: ${err.message}`,
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
