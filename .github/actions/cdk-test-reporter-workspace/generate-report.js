// .github/actions/cdk-test-reporter-workspace/generate-report.js
//
// Generates a per-workspace Markdown fragment from the four jest log files.
// The CI workflow concatenates every fragment into a single sticky PR comment,
// so this script intentionally does NOT talk to the GitHub API.
//
// Usage:
//   node generate-report.js <workspaceName> <logDir> <outFile> \
//        <snapshotCode> <unitCode> <integrationCode> <complianceCode>

const fs = require('fs');
const path = require('path');

const [workspaceName, logDir, outFile, snapshotCode, unitCode, integrationCode, complianceCode] =
  process.argv.slice(2);

const readLog = (name) => {
  try {
    return fs.readFileSync(path.join(logDir, name), 'utf8');
  } catch {
    return '';
  }
};

const extractSummary = (log) => {
  // Pattern 1: "Tests: X failed, Y passed, Z total"
  let match = log.match(/Tests:\s+(\d+)\s+failed.*?(\d+)\s+passed.*?(\d+)\s+total/s);
  if (match) {
    return { failed: parseInt(match[1]), passed: parseInt(match[2]), total: parseInt(match[3]) };
  }
  // Pattern 2: "Tests: Y passed, Z total"
  match = log.match(/Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total/);
  if (match) {
    return { failed: 0, passed: parseInt(match[1]), total: parseInt(match[2]) };
  }
  // Pattern 3: no tests collected (jest --passWithNoTests)
  if (log.includes('No tests found')) {
    return { failed: 0, passed: 0, total: 0 };
  }
  return null;
};

const suites = [
  { name: 'Snapshot', code: snapshotCode, log: readLog('snapshot-test.log') },
  { name: 'Unit', code: unitCode, log: readLog('unit-test.log') },
  { name: 'Integration', code: integrationCode, log: readLog('integration-test.log') },
  { name: 'Compliance', code: complianceCode, log: readLog('compliance-test.log') },
];

const allPassed = suites.every((s) => s.code === '0');
const header = `### \`${workspaceName}\` — ${allPassed ? '✅ passed' : '❌ failed'}`;

let report = `${header}\n\n`;
report += `| Test | Status | Passed | Failed | Total |\n`;
report += `|------|:------:|-------:|-------:|------:|\n`;

for (const s of suites) {
  const status = s.code === '0' ? '✅' : '❌';
  const sum = extractSummary(s.log);
  if (sum) {
    report += `| ${s.name} | ${status} | ${sum.passed} | ${sum.failed} | ${sum.total} |\n`;
  } else {
    report += `| ${s.name} | ${status} | - | - | - |\n`;
  }
}

if (!allPassed) {
  for (const s of suites) {
    if (s.code === '0') continue;
    const errorLines = s.log
      .split('\n')
      .filter(
        (line) =>
          line.includes('FAIL') ||
          line.includes('●') ||
          line.includes('Error:') ||
          line.includes('Expected:') ||
          line.includes('Received:'),
      )
      .filter((line) => !line.includes('● Console'))
      .slice(0, 80);
    report += `\n<details>\n<summary>❌ ${s.name} failures</summary>\n\n`;
    report += '```\n' + (errorLines.join('\n') || '(no parseable error lines — see workflow logs)') + '\n```\n\n';
    report += `</details>\n`;
  }
}

report += `\n`;

fs.writeFileSync(outFile, report);

console.log(`\n=== Fragment for ${workspaceName} (${allPassed ? 'passed' : 'failed'}) ===\n`);
console.log(report);
