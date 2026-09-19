#!/usr/bin/env node
/**
 * Regenerates rss.xml (repository root) from pages/patterns.json.
 *
 * Only patterns without `"draft": true` are published to the feed — a draft
 * entry means the architecture has not been deploy-verified yet (see
 * ".agent/reference/new-architecture-workflow.md" section "Draft patterns").
 * Run this script after removing `draft: true` from a pattern (i.e. after
 * confirming a real `cdk deploy` works) so the feed announces the update:
 *
 *   node scripts/generate-rss.js
 *
 * The script is idempotent — it always rebuilds the full feed from the
 * current patterns.json rather than appending, so re-running it after
 * editing any entry (title, description, tags, date) keeps rss.xml in sync
 * without manual XML editing.
 */
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const PATTERNS_PATH = path.join(REPO_ROOT, "pages", "patterns.json");
const OUT_PATH = path.join(REPO_ROOT, "rss.xml");

const SITE_URL = "https://ishiharatma.github.io/aws-cdk-reference-architectures/";
const REPO_TREE_URL = "https://github.com/ishiharatma/aws-cdk-reference-architectures/tree/main/infrastructure/workspaces";
const FEED_TITLE = "AWS CDK Reference Architectures";
const FEED_DESCRIPTION = "Newly published and newly deploy-verified AWS CDK reference architectures.";

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// patterns.json dates are "YYYY-MM-DD" with no time-of-day; anchor at
// noon UTC so the RFC-822 pubDate doesn't drift to the previous/next day
// depending on the reader's timezone.
function toRfc822(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toUTCString();
}

const patterns = JSON.parse(fs.readFileSync(PATTERNS_PATH, "utf8"));
const published = patterns
  .filter((p) => p.draft !== true)
  .slice()
  .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

const lastBuildDate = new Date().toUTCString();

const items = published
  .map((p) => {
    const link = `${REPO_TREE_URL}/${p.link}`;
    const categories = (p.tags || []).map((t) => `      <category>${xmlEscape(t)}</category>`).join("\n");
    return [
      "    <item>",
      `      <title>${xmlEscape(p.title)}</title>`,
      `      <link>${xmlEscape(link)}</link>`,
      `      <guid isPermaLink="true">${xmlEscape(link)}</guid>`,
      `      <pubDate>${toRfc822(p.date)}</pubDate>`,
      `      <description>${xmlEscape(p.description)}</description>`,
      categories,
      "    </item>",
    ]
      .filter(Boolean)
      .join("\n");
  })
  .join("\n");

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape(FEED_TITLE)}</title>
    <link>${xmlEscape(SITE_URL)}</link>
    <description>${xmlEscape(FEED_DESCRIPTION)}</description>
    <language>en</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
${items}
  </channel>
</rss>
`;

fs.writeFileSync(OUT_PATH, rss);
console.log(`wrote ${OUT_PATH} (${published.length} items, ${patterns.length - published.length} draft skipped)`);
