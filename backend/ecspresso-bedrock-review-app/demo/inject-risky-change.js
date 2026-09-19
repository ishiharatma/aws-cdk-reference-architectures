#!/usr/bin/env node
/**
 * Applies or reverts an intentionally risky code change to src/index.js, so
 * the Agentic Review gate can be exercised end-to-end against a diff that
 * should actually trip it. Not part of the pipeline or the app itself --
 * run manually, on a scratch branch. See demo/README.md.
 *
 * Usage:
 *   node demo/inject-risky-change.js apply
 *   node demo/inject-risky-change.js revert
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TARGET_FILE = path.join(__dirname, '..', 'src', 'index.js');
const SNIPPET_FILE = path.join(__dirname, 'risky-snippet.js');
const MARKER = '// DEMO_INJECTION_POINT';
const START = '// === DEMO:RISKY-CODE-START ===';
const END = '// === DEMO:RISKY-CODE-END ===';

function apply() {
  const target = fs.readFileSync(TARGET_FILE, 'utf8');
  if (target.includes(START)) {
    console.error('Risky demo code is already applied. Run `revert` first.');
    process.exitCode = 1;
    return;
  }
  const markerIndex = target.indexOf(MARKER);
  if (markerIndex === -1) {
    console.error(`Could not find "${MARKER}" in ${TARGET_FILE}.`);
    process.exitCode = 1;
    return;
  }
  const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8').trim();
  const block = `${START}\n${snippet}\n${END}\n\n`;
  const updated = target.slice(0, markerIndex) + block + target.slice(markerIndex);
  fs.writeFileSync(TARGET_FILE, updated);
  console.log(`Applied the risky demo change to ${path.relative(process.cwd(), TARGET_FILE)}.`);
  console.log('Review the diff, commit it, and push to trigger the AgenticReview stage:');
  console.log('  git diff -- src/index.js');
  console.log('  git add src/index.js && git commit -m "demo: intentionally risky change for agentic review testing"');
  console.log('  git push origin develop');
  console.log('Once you have confirmed the pipeline blocks it, run: node demo/inject-risky-change.js revert');
}

function revert() {
  const target = fs.readFileSync(TARGET_FILE, 'utf8');
  const startIndex = target.indexOf(START);
  const endIndex = target.indexOf(END);
  if (startIndex === -1 || endIndex === -1) {
    console.log('No risky demo change found -- nothing to revert.');
    return;
  }
  const afterEnd = endIndex + END.length;
  // Also eat the blank line(s) `apply()` left after the block, if present.
  let sliceEnd = afterEnd;
  while (target[sliceEnd] === '\n') {
    sliceEnd += 1;
  }
  const updated = target.slice(0, startIndex) + target.slice(sliceEnd);
  fs.writeFileSync(TARGET_FILE, updated);
  console.log(`Reverted the risky demo change in ${path.relative(process.cwd(), TARGET_FILE)}.`);
  console.log('  git add src/index.js && git commit -m "revert: remove agentic review demo change"');
  console.log('  git push origin develop');
}

const command = process.argv[2];
if (command === 'apply') {
  apply();
} else if (command === 'revert') {
  revert();
} else {
  console.error('Usage: node demo/inject-risky-change.js <apply|revert>');
  process.exitCode = 1;
}
