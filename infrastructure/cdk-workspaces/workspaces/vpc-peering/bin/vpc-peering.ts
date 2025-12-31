#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from 'change-case-commonjs';
import { params } from 'parameters/environments';
import { VpcPeeringStage } from 'lib/stages/vpc-peering-stage';
import { Environment } from '@common/parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters'

const app = new cdk.App();

// Get environment (specified in cdk.json context or at runtime with --context)
const pjName: string = app.node.tryGetContext('project');
const envName: Environment =
  app.node.tryGetContext('env') || Environment.DEVELOPMENT;

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

const envParams = params[envName]!;

validateDeployment(pjName, envName, envParams.accountAId);

const defaultEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT || envParams.accountAId,
  region: process.env.CDK_DEFAULT_REGION || envParams.regionA,
};

// Whether to force delete an S3 bucket even if objects exist
// Determine by environment identifier
const isAutoDeleteObject = envName === Environment.DEVELOPMENT;

// Before you can use cdk destroy to delete a deletion-protected stack, 
// you must disable deletion protection for the stack in the management console.
const isTerminationProtection = envName === Environment.PRODUCTION;

// Create VPC Peering Stack (Account A: VPC A <-> VPC B)
new VpcPeeringStage(app, `${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection,
  isAutoDeleteObject: isAutoDeleteObject,
  params: envParams,
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(app).add("Project", pjName);
cdk.Tags.of(app).add("Environment", envName);
