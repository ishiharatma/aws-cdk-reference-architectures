#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import { params } from 'parameters/environments';
import { sharedParams } from 'parameters/shared-params';
import 'parameters'; // registers dev-params into `params` as a side effect

import { EcspressoBedrockReviewStage } from 'lib/stages/ecspresso-bedrock-review-stage';

const app = new cdk.App();

// Get environment (specified in cdk.json context or at runtime with --context)
const pjName: string = process.env.PROJECT || app.node.tryGetContext('project');
const envName: Environment =
  (process.env.ENV as Environment) || app.node.tryGetContext('env') || Environment.DEVELOPMENT;

const defaultEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

validateDeployment(pjName, envName, envParams.accountId);

// Sample workspace — safe to auto-delete objects and skip termination protection.
const isAutoDeleteObject = true;
const isTerminationProtection = false;

const stage = new EcspressoBedrockReviewStage(app, `EcspressoBedrockReview${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection,
  isAutoDeleteObject: isAutoDeleteObject,
  sharedParams,
  params: envParams,
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add('Project', pjName);
cdk.Tags.of(stage).add('Environment', envName);
cdk.Tags.of(stage).add('ManagedBy', 'CDK');
