import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DiffEntry, FetchEolDiffResult } from '../common/eol-types';

const bedrock = new BedrockRuntimeClient({});

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? '';
const LOCALE = process.env.LOCALE ?? 'ja';

export interface GenerateReportResult {
  readonly subject: string;
  readonly body: string;
}

/** Highest-severity diff type present, used to pick the subject's urgency label. */
function highestSeverity(diffs: DiffEntry[]): 'critical' | 'warning' | 'info' {
  const hasEol = diffs.some((d) => d.status === 'END_OF_LIFE' || d.status === 'DEPRECATED');
  if (hasEol) return 'critical';
  const hasUpcoming = diffs.some((d) => d.type === 'UPCOMING_EOL');
  if (hasUpcoming) return 'warning';
  return 'info';
}

function buildSubject(input: FetchEolDiffResult): string {
  const severity = highestSeverity(input.diffs);
  const label =
    LOCALE === 'ja'
      ? { critical: '🚨要対応', warning: '⚠️期限接近', info: 'ℹ️情報' }[severity]
      : { critical: '🚨 ACTION NEEDED', warning: '⚠️ UPCOMING', info: 'ℹ️ INFO' }[severity];
  return LOCALE === 'ja'
    ? `[AWS EOL監視] ${label} - ${input.diffCount}件の変更を検知`
    : `[AWS EOL Monitor] ${label} - ${input.diffCount} change(s) detected`;
}

/**
 * Builds the prompt handed to Bedrock. The diff list is passed as raw JSON
 * rather than pre-formatted text: the model does the prioritization and
 * Japanese/English write-up, but every fact it can state (dates, statuses,
 * URLs) still traces back to a field in this JSON, not to something it
 * invented from parametric knowledge.
 */
function buildPrompt(input: FetchEolDiffResult): string {
  const diffsJson = JSON.stringify(input.diffs, null, 2);

  if (LOCALE === 'ja') {
    return `あなたはAWSのプラットフォーム運用チーム向けに、サービス/バージョンのEOL(サポート終了)情報をレポートするアシスタントです。
以下はAWSの公開データセット(awslabs/aws-service-eol-data)から検出した「前回チェック時からの変化」のリストです(JSON形式)。

- type: "NEW" = 新たに追跡を開始したバージョン
- type: "STATUS_CHANGED" = サポートステータスが変化した(previousStatus -> status)
- type: "UPCOMING_EOL" = 標準サポート終了(standardSupportEnd)が閾値日数以内に接近した
- status: STANDARD_SUPPORT(標準サポート中) / EXTENDED_SUPPORT(延長サポート中) / DEPRECATED(廃止予定) / END_OF_LIFE(サポート終了)

差分データ:
\`\`\`json
${diffsJson}
\`\`\`

このデータだけを根拠に、日本語のMarkdownレポートを作成してください。要件:
1. 冒頭に3行以内の要約(最も緊急度の高い項目を明示)
2. 「今すぐ対応が必要」「早めに計画すべき」「情報として記録」の3段階で優先順位付けした表またはリストにする
3. 各項目にサービス名・バージョン・ステータス・標準サポート終了日・出典URL(sourceUrl)を含める
4. データにない情報(推測の移行手順など)は書かない。移行の必要性を指摘するのは良いが、具体的な移行手順は「公式ドキュメントで確認してください」と案内する
5. 全体は日本語、見出しはMarkdownの##を使う`;
  }

  return `You are an assistant reporting AWS service/version end-of-life (EOL) information to a platform operations team.
Below is a JSON list of changes detected since the last check, sourced from the public dataset awslabs/aws-service-eol-data.

- type "NEW": a version newly tracked
- type "STATUS_CHANGED": support status transitioned (previousStatus -> status)
- type "UPCOMING_EOL": standardSupportEnd is now within the configured threshold

Diff data:
\`\`\`json
${diffsJson}
\`\`\`

Using only this data, write a Markdown report that:
1. Opens with a 3-line-or-less summary naming the most urgent item(s)
2. Groups items into "Act now", "Plan ahead", and "For the record" priority tiers
3. Lists, per item, the service name, version, status, standardSupportEnd date, and sourceUrl
4. Never invents facts not present in the data (e.g. migration steps) — point readers to the official docs instead
5. Uses Markdown ## headings throughout`;
}

export async function handler(input: FetchEolDiffResult): Promise<GenerateReportResult> {
  const prompt = buildPrompt(input);

  const response = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 2000, temperature: 0.3 },
    }),
  );

  const body =
    response.output?.message?.content?.find((block) => block.text)?.text ??
    (LOCALE === 'ja' ? '(レポート生成に失敗しました。元の差分データを確認してください)' : '(Report generation failed; check the raw diff data)');

  return { subject: buildSubject(input), body };
}
