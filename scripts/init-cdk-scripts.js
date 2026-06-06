#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

try {
  const workspaceDir = process.argv[2] || 'infrastructure/cdk';
  const packageJsonPath = path.join(__dirname, '..', workspaceDir, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    console.error('Error: package.json not found at', packageJsonPath);
    console.error('Usage: node add-scripts.js [workspace-directory]');
    console.error('Example: node add-scripts.js infrastructure/cdk');
    console.error('Example: node add-scripts.js workspaces/my-usecase');
    process.exit(1);
  }
  // Read package.json
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // Scripts to add
  const newRoot = {
    "private": "true",
    "workspaces": [
      "workspaces\\*"
    ],
    "lint-staged": {
      "src/**/*.{ts,tsx}": "npm run lint:precommit",
      "src/**/*.{js,jsx,ts,tsx,json,css,scss}": "npm run fmt:precommit"
    },
  };
  const newScripts = {
    "lint:workspace": "eslint workspaces/$npm_config_workspace",
    "lint:workspace:fix": "eslint workspaces/$npm_config_workspace --fix",
    "lint:precommit": "eslint 'workspaces/**/*.{ts,tsx}' --max-warnings 0",
    "fmt:precommit": "prettier -l './**/*.{js,jsx,ts,tsx,json,css,scss}'"
  };


  // Check for existing scripts to avoid duplicates
  const existingRoot = Object.keys(packageJson);
  const newRootKeys = Object.keys(newRoot);
  const duplicatesRoot = newRootKeys.filter(key => existingRoot.includes(key));
  if (duplicatesRoot.length > 0) {
    console.log('The following scripts already exist and will be overwritten:');
    duplicatesRoot.forEach(key => console.log(`  - ${key}: ${packageJson[key]}`));
  }

  Object.assign(packageJson, newRoot);

  const existingScripts = Object.keys(packageJson.scripts);
  const newScriptKeys = Object.keys(newScripts);
  const duplicates = newScriptKeys.filter(key => existingScripts.includes(key));

  if (duplicates.length > 0) {
    console.log('The following scripts already exist and will be overwritten:');
    duplicates.forEach(key => console.log(`  - ${key}: ${packageJson.scripts[key]}`));
  }

  // Add to scripts section
  Object.assign(packageJson.scripts, newScripts);

  // Write back to file
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

  console.log(`✅ Scripts added successfully to ${workspaceDir}/package.json!`);
  console.log('Added/Updated scripts:');
  newRootKeys.forEach(key => console.log(`  - ${key}: ${newRoot[key]}`));
  newScriptKeys.forEach(key => console.log(`  - ${key}: ${newScripts[key]}`));


} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}