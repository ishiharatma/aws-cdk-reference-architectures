#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from 'change-case-commonjs';
import { params } from 'parameters/environments';
import { ApigwLambdaWebAdapterStage } from 'lib/stages/apigw-lambda-web-adapter-stage';
import { Environment } from '@common/parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters';

const app = new cdk.App();

const pjName: string = app.node.tryGetContext('project');
const envName: Environment = app.node.tryGetContext('env') || Environment.DEVELOPMENT;

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

const envParams = params[envName]!;

validateDeployment(pjName, envName, envParams.accountId);

const defaultEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT || envParams.accountId,
  region: process.env.CDK_DEFAULT_REGION || envParams.region,
};

const isAutoDeleteObject = envName === Environment.DEVELOPMENT;
const isTerminationProtection = envName === Environment.PRODUCTION;

const stage = new ApigwLambdaWebAdapterStage(app, `ApigwLambdaWebAdapter${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection,
  isAutoDeleteObject,
  params: envParams,
});

cdk.Tags.of(stage).add('Project', pjName);
cdk.Tags.of(stage).add('Environment', envName);
cdk.Tags.of(stage).add('ManagedBy', 'CDK');
