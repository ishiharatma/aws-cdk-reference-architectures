#!/usr/bin/env node
// This script adds predefined scripts to the package.json of a specified CDK workspace
// Usage: node add-scripts.js [workspace-directory]
// Example: node add-scripts.js cdk
// Example: node add-scripts.js workspaces/my-usecase

const fs = require('fs');
const path = require('path');

try {
  // Get workspace directory from command line arguments or default to 'infrastructure/cdk-workspaces'
  const workspaceDir = process.argv[2] || 'infrastructure/cdk-workspaces';
  const packageJsonPath = path.join(__dirname, '..', workspaceDir, 'package.json');
  const cdkJsonPath = path.join(__dirname, '..', workspaceDir, 'cdk.json');

  if (!fs.existsSync(packageJsonPath)) {
    console.error('Error: package.json not found at', packageJsonPath);
    console.error('Usage: node add-scripts.js [workspace-directory]');
    console.error('Example: node add-scripts.js infrastructure/cdk-workspaces');
    console.error('Example: node add-scripts.js workspaces/my-usecase');
    process.exit(1);
  }
  if (!fs.existsSync(cdkJsonPath)) {
    console.error('Error: cdk.json not found at', cdkJsonPath);
    console.error('Make sure the specified directory is a valid CDK workspace.');
    process.exit(1);
  }
  // Load package.json
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // add new scripts
  const newScripts = {
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "test:unit": "jest test/unit",
    "test:snapshot": "jest test/snapshot",
    "test:snapshot:update": "jest test/snapshot --updateSnapshot",
    "test:integration": "jest test/integration",
    "test:compliance": "jest test/compliance",
    "bootstrap": "echo Environment: ${npm_config_env} && COMMIT_HASH=$(git rev-parse --short HEAD) cdk bootstrap  --version-reporting false --asset-metadata false -c project=${npm_config_project} -c env=${npm_config_env} --profile ${npm_config_project}-${npm_config_env}",
    "diff": "echo Environment: ${npm_config_env} && COMMIT_HASH=$(git rev-parse --short HEAD) cdk diff --version-reporting false --asset-metadata false -c project=${npm_config_project} -c env=${npm_config_env} --profile ${npm_config_project}-${npm_config_env}",
    "synth": "echo Environment: ${npm_config_env} && COMMIT_HASH=$(git rev-parse --short HEAD) cdk synth  --version-reporting false --asset-metadata false -c project=${npm_config_project} -c env=${npm_config_env} --profile ${npm_config_project}-${npm_config_env}",
    "deploy:all": "echo Environment: ${npm_config_env} && COMMIT_HASH=$(git rev-parse --short HEAD) cdk deploy --all --version-reporting false --asset-metadata false -c project=${npm_config_project} -c env=${npm_config_env} --profile ${npm_config_project}-${npm_config_env}",
    "destroy:all": "echo Environment: ${npm_config_env} && cdk destroy --all -c project=${npm_config_project} -c env=${npm_config_env} --profile ${npm_config_project}-${npm_config_env}",
    "stage:deploy:all": "echo Environment: ${npm_config_env} && COMMIT_HASH=$(git rev-parse --short HEAD) cdk deploy '**' --version-reporting false --asset-metadata false -c project=${npm_config_project} -c env=${npm_config_env} --profile ${npm_config_project}-${npm_config_env}",
    "stage:destroy:all": "echo Environment: ${npm_config_env} && cdk destroy '**' -c project=${npm_config_project} -c env=${npm_config_env} --profile ${npm_config_project}-${npm_config_env}",
    "lint": "eslint \"**/*.ts\"",
    "lint:fix": "eslint \"**/*.ts\" --fix",
    "format": "prettier --write \"**/*.ts\""
  };

  // Check existing scripts to avoid duplicates
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
  newScriptKeys.forEach(key => console.log(`  - ${key}: ${newScripts[key]}`));


  // Load cdk.json (only check existence, do not use content)
  const cdkJson = JSON.parse(fs.readFileSync(cdkJsonPath, 'utf8'));
  const newContexts = {
    //"project": "example",
  };

  // Check existing context to avoid duplicates
  const existingContexts = cdkJson.context || {};
  const newContextKeys = Object.keys(newContexts);
  const contextDuplicates = newContextKeys.filter(key => key in existingContexts);

  if (contextDuplicates.length > 0) {
    console.log('The following context keys already exist and will be overwritten:');
    contextDuplicates.forEach(key => console.log(`  - ${key}: ${existingContexts[key]}`));
  }

  // Add to context section
  cdkJson.context = { ...existingContexts, ...newContexts };

  // Write back to file
  fs.writeFileSync(cdkJsonPath, JSON.stringify(cdkJson, null, 2) + '\n');

  console.log(`✅ Context added successfully to ${workspaceDir}/cdk.json!`);
  console.log('Added/Updated context:');
  newContextKeys.forEach(key => console.log(`  - ${key}: ${newContexts[key]}`));

} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}