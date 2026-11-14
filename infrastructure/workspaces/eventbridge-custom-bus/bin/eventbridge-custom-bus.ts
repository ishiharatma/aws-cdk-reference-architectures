#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { params } from 'parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import { EmulatorCompatAspect } from '@common/aspects/emulator-compat-aspect';
import 'parameters'; // registers dev-params into `params` as a side effect

import { EventbridgeCustomBusStage } from 'lib/stages/eventbridge-custom-bus-stage';

const app = new cdk.App();

const pjName: string = process.env.PROJECT || app.node.tryGetContext('project');
const envName: Environment = (process.env.ENV as Environment) || app.node.tryGetContext('env') || Environment.DEVELOPMENT;

const defaultEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

const envParams = params[envName];

validateDeployment(pjName, envName, envParams.accountId);

// Reference/learning stack: removable outside production.
const isAutoDeleteObject = envName !== Environment.PRODUCTION;
const isTerminationProtection = envName === Environment.PRODUCTION;

const stage = new EventbridgeCustomBusStage(app, `EventbridgeCustomBus${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection,
  isAutoDeleteObject,
  params: envParams,
});

// Local testing against AWS Emulator only (`-c emulator=true`); never set for real AWS.
// Added to the Stage, not the App: aspects on the App do not cross Stage boundaries.
if (app.node.tryGetContext('emulator') === 'true') {
  cdk.Aspects.of(stage).add(new EmulatorCompatAspect());
}

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add('Project', pjName);
cdk.Tags.of(stage).add('Environment', envName);
cdk.Tags.of(stage).add('ManagedBy', 'CDK');
