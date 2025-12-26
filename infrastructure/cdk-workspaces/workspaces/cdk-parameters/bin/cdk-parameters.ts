#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from "change-case-commonjs";
import { params } from "parameters/environments";
import { CdkParametersStage } from 'lib/stages/cdk-parameters-stage';
import { Environment } from 'lib/types/common';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters'

const app = new cdk.App();

// Get environment (specified in cdk.json context or at runtime with --context)
const pjName: string = app.node.tryGetContext("project");
const envName: Environment =
  app.node.tryGetContext("env") || Environment.DEVELOPMENT;

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

validateDeployment(pjName, envName, params[envName].accountId);

const defaultEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Whether to force delete an S3 bucket even if objects exist
// Determine by environment identifier
//const isAutoDeleteObject:boolean = envName.match(/^(dev|test|stage)$/) ? true: false;
// Since it is a test, it can be deleted
const isAutoDeleteObject = true;

// Before you can use cdk destroy to delete a deletion-protected stack, you must disable deletion protection for the stack in the management console.
// const isTerminationProtection:boolean = envName.match(/^(dev|test)$/) ? false: true;
// Since it is a test, it can be deleted
const isTerminationProtection = false;

new CdkParametersStage(app, `${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection, // Enabling deletion protection
  isAutoDeleteObject: isAutoDeleteObject,
  params: params[envName],
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(app).add("Project", pjName);
cdk.Tags.of(app).add("Environment", envName);
