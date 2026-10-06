#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { params, ServerMode } from 'parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters'; // registers dev-params into `params` as a side effect

import { TransferSftpCustomIdpStage } from 'lib/stages/transfer-sftp-custom-idp-stage';

const app = new cdk.App();

// Get environment (specified in cdk.json context or at runtime with --context)
const pjName: string = process.env.PROJECT || app.node.tryGetContext("project");
const envName: Environment =
  process.env.ENV as Environment ||
  app.node.tryGetContext("env")  || Environment.DEVELOPMENT;

const defaultEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

// Server run mode can be overridden per deployment: -c serverMode=always|scheduled|manual
// (scheduled also accepts -c scheduleStart=... -c scheduleStop=... -c scheduleTimezone=... -c hostKeySecretArn=...)
const baseParams = params[envName];
const ctx = (key: string): string | undefined => app.node.tryGetContext(key);
const envParams = {
  ...baseParams,
  serverLifecycle: {
    ...baseParams.serverLifecycle,
    mode: (ctx('serverMode') ?? baseParams.serverLifecycle.mode) as ServerMode,
    startExpression: ctx('scheduleStart') ?? baseParams.serverLifecycle.startExpression,
    stopExpression: ctx('scheduleStop') ?? baseParams.serverLifecycle.stopExpression,
    timezone: ctx('scheduleTimezone') ?? baseParams.serverLifecycle.timezone,
    hostKeySecretArn: ctx('hostKeySecretArn') ?? baseParams.serverLifecycle.hostKeySecretArn,
  },
};

validateDeployment(pjName, envName, envParams.accountId);

const stage = new TransferSftpCustomIdpStage(app, `TransferSftpCustomIdp${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: false,
  isAutoDeleteObject: !envParams.retainData,
  params: envParams,
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add("Project", pjName);
cdk.Tags.of(stage).add("Environment", envName);
cdk.Tags.of(stage).add("ManagedBy", "CDK");
