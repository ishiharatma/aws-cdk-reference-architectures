#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { params } from 'parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters'; // registers dev-params into `params` as a side effect

import { ClientVpnVsOpenvpnWireguardStage } from 'lib/stages/client-vpn-vs-openvpn-wireguard-stage';

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

const envParams = params[envName];

validateDeployment(pjName, envName, envParams.accountId);

// Before you can use cdk destroy to delete a deletion-protected stack, you must disable deletion protection for the stack in the management console.
// Since it is a verification environment, it can be deleted
const isTerminationProtection = false;

const stage = new ClientVpnVsOpenvpnWireguardStage(app, `ClientVpnVsOpenvpnWireguard${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection,
  params: envParams,
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add("Project", pjName);
cdk.Tags.of(stage).add("Environment", envName);
cdk.Tags.of(stage).add("ManagedBy", "CDK");
