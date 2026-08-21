#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { params } from 'parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters'; // registers dev-params into `params` as a side effect

import { AwsBackupCrossRegionStage } from 'lib/stages/aws-backup-cross-region-stage';

const app = new cdk.App();

// Get environment (specified in cdk.json context or at runtime with --context)
const pjName: string = process.env.PROJECT_NAME || app.node.tryGetContext("project");
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

const envParams = params[envName];

validateDeployment(pjName, envName, envParams.accountId);

// Whether to force delete the sample S3 buckets even if objects exist.
// These are demo/reference resources, so this can be left true.
const isAutoDeleteObject = true;

// Before you can use cdk destroy to delete a deletion-protected stack, you must disable
// deletion protection for the stack in the management console.
// Since it is a test, it can be deleted.
const isTerminationProtection = false;

const stage = new AwsBackupCrossRegionStage(app, `AwsBackupCrossRegion${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection,
  isAutoDeleteObject: isAutoDeleteObject,
  params: envParams,
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add("Project", pjName);
cdk.Tags.of(stage).add("Environment", envName);
cdk.Tags.of(stage).add("ManagedBy", "CDK");
