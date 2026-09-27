#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { params } from 'parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters'; // registers dev-params/prd-params into `params` as a side effect

import { AwsEolMonitorStage } from 'lib/stages/aws-eol-monitor-stage';

const app = new cdk.App();

// Get environment (specified in cdk.json context or at runtime with --context)
const pjName: string = process.env.PROJECT_NAME || app.node.tryGetContext('project');
const envName: Environment =
  (process.env.ENV as Environment) || app.node.tryGetContext('env') || Environment.DEVELOPMENT;

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

const envParams = params[envName];

validateDeployment(pjName, envName, envParams.accountId);

const defaultEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT || envParams.accountId,
  region: process.env.CDK_DEFAULT_REGION || envParams.region,
};

// Whether to force delete resources even if not empty (dev/test convenience)
const isAutoDeleteObject = envName !== Environment.PRODUCTION;

// Before you can use cdk destroy to delete a deletion-protected stack, you must disable deletion protection for the stack in the management console.
const isTerminationProtection = envName === Environment.PRODUCTION;

if ((envParams.notification.emails[0] ?? 'change-me@example.com') === 'change-me@example.com') {
  console.warn(
    'WARNING: notification.emails is still the placeholder address. Edit parameters/*.ts before deploying.',
  );
}

const stage = new AwsEolMonitorStage(app, `AwsEolMonitor${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection,
  isAutoDeleteObject: isAutoDeleteObject,
  params: envParams,
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add('Project', pjName);
cdk.Tags.of(stage).add('Environment', envName);
cdk.Tags.of(stage).add('ManagedBy', 'CDK');
