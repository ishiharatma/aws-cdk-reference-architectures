#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { EcsFargateAlbStage } from 'lib/stages/ecs-fargate-alb-stage';
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { validateDeployment } from '@common/helpers/validate-deployment';
import { getMyGlobalIpCidr } from "@common/helpers/get-my-ip";
import { params } from 'parameters/environments';
import 'parameters'

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

// Whether to force delete an S3 bucket even if objects exist
// Determine by environment identifier
//const isAutoDeleteObject:boolean = envName.match(/^(dev|test|stage)$/) ? true: false;
// Since it is a test, it can be deleted
const isAutoDeleteObject = true;

// Before you can use cdk destroy to delete a deletion-protected stack, you must disable deletion protection for the stack in the management console.
// const isTerminationProtection:boolean = envName.match(/^(dev|test)$/) ? false: true;
// Since it is a test, it can be deleted
const isTerminationProtection = false;

const stage = new EcsFargateAlbStage(app, `${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection, // Enabling deletion protection
  isAutoDeleteObject: isAutoDeleteObject,
  params: envParams,
  allowedIpsforAlb: [getMyGlobalIpCidr()],
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add("Project", pjName);
cdk.Tags.of(stage).add("Environment", envName);