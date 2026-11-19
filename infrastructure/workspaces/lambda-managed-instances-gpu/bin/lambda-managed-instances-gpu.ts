#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { params } from 'parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters'; // registers dev-params into `params` as a side effect

import { LambdaManagedInstancesGpuStage } from 'lib/stages/lambda-managed-instances-gpu-stage';

const app = new cdk.App();

const pjName: string = process.env.PROJECT || app.node.tryGetContext('project');
const envName: Environment =
  (process.env.ENV as Environment) || app.node.tryGetContext('env') || Environment.DEVELOPMENT;

const defaultEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

const envParams = params[envName];

validateDeployment(pjName, envName, envParams.accountId);

// Sample architecture: allow cdk destroy to remove buckets, tables and log groups
const isAutoDeleteObject = true;
const isTerminationProtection = false;

const stage = new LambdaManagedInstancesGpuStage(app, `LambdaManagedInstancesGpu${pascalCase(envName)}`, {
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
