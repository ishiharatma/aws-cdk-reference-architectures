#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { getMyGlobalIp } from "@common/helpers/get-my-ip";
import { params } from 'parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters'; // registers dev-params into `params` as a side effect

import { EksManagedNodeGroupVsAutoModeStage } from 'lib/stages/eks-managed-node-group-vs-auto-mode-stage';

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
// Since it is a test, it can be deleted
const isTerminationProtection = false;

// Client IPv4 addresses allowed to reach the ALBs and the public EKS API endpoints. Prefer the
// explicit env var (comma-separated, e.g. `ALLOWED_IPS=1.2.3.4,5.6.7.8`); otherwise the
// deploying machine's global IP is used. Both clusters are IPv4 only, so no IPv6 list is taken.
const allowedIps = process.env.ALLOWED_IPS?.split(',').map(ip => ip.trim()).filter(Boolean) ?? [getMyGlobalIp()];
console.log(`IPv4s: ${allowedIps.join(', ')}`);

// IAM role granted cluster-admin through an EKS access entry, for kubectl after deployment.
// Use the full role ARN as returned by `aws iam get-role`; for IAM Identity Center roles that
// includes the `aws-reserved/sso.amazonaws.com/<region>/` path (a path-less ARN is rejected as an
// invalid principal, unlike in the legacy aws-auth ConfigMap).
const adminPrincipalArn = process.env.EKS_ADMIN_PRINCIPAL_ARN || undefined;

const stage = new EksManagedNodeGroupVsAutoModeStage(app, `EksManagedNodeGroupVsAutoMode${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection,
  params: envParams,
  allowedIps,
  adminPrincipalArn,
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add("Project", pjName);
cdk.Tags.of(stage).add("Environment", envName);
cdk.Tags.of(stage).add("ManagedBy", "CDK");
