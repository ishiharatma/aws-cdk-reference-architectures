#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { VpcBasicsStage } from "lib/stages/vpc-basics-stage";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";

const app = new cdk.App();

// Get environment (specified in cdk.json context or at runtime with --context)
const pjName: string = app.node.tryGetContext("project");
const envName: Environment =
  app.node.tryGetContext("env") || Environment.DEVELOPMENT;

const defaultEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

console.log(`Project Name: ${pjName}`);
console.log(`Environment Name: ${envName}`);

// Whether to force delete an S3 bucket even if objects exist
// Determine by environment identifier
//const isAutoDeleteObject:boolean = envName.match(/^(dev|test|stage)$/) ? true: false;
// Since it is a test, it can be deleted
const isAutoDeleteObject = true;

// Before you can use cdk destroy to delete a deletion-protected stack, you must disable deletion protection for the stack in the management console.
// const isTerminationProtection:boolean = envName.match(/^(dev|test)$/) ? false: true;
// Since it is a test, it can be deleted
const isTerminationProtection = false;

new VpcBasicsStage(app, `${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection, // Enabling deletion protection
  isAutoDeleteObject: isAutoDeleteObject,
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(app).add("Project", pjName);
cdk.Tags.of(app).add("Environment", envName);
