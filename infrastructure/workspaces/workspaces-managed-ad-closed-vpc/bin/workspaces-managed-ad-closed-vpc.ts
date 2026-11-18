#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { params } from 'parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters'; // registers dev-params into `params` as a side effect

import { WorkspacesManagedAdClosedVpcStage } from 'lib/stages/workspaces-managed-ad-closed-vpc-stage';

const app = new cdk.App();

// Get environment (specified in cdk.json context or at runtime with --context)
const pjName: string = process.env.PROJECT || app.node.tryGetContext('project');
const envName: Environment =
  (process.env.ENV as Environment) || app.node.tryGetContext('env') || Environment.DEVELOPMENT;

const baseParams = params[envName];
if (!baseParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

validateDeployment(pjName, envName, baseParams.accountId);

const defaultEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || baseParams.region,
};

// The IP access control group must list the standard PCs' egress IPs, which are not the
// deploying machine's IP, so there is no auto-detection. `ALLOWED_IPS=1.2.3.4/32,5.6.7.0/28`
// overrides the parameter file for a one-off deployment.
const allowedFromEnv = process.env.ALLOWED_IPS?.split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => ({
    cidr: value.includes('/') ? value : `${value}/32`,
    description: 'From ALLOWED_IPS',
  }));
const envParams = allowedFromEnv?.length
  ? { ...baseParams, workspaces: { ...baseParams.workspaces, allowedSources: allowedFromEnv } }
  : baseParams;
console.log(
  `WorkSpaces allowed sources: ${envParams.workspaces.allowedSources.map((rule) => rule.cidr).join(', ')}`
);

// Verification environment: everything can be deleted.
const isAutoDeleteObject = envName !== Environment.PRODUCTION;
const isTerminationProtection = envName === Environment.PRODUCTION;

const stage = new WorkspacesManagedAdClosedVpcStage(
  app,
  `WorkspacesManagedAdClosedVpc${pascalCase(envName)}`,
  {
    project: pjName,
    environment: envName,
    env: defaultEnv,
    terminationProtection: isTerminationProtection,
    isAutoDeleteObject,
    params: envParams,
  }
);

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add('Project', pjName);
cdk.Tags.of(stage).add('Environment', envName);
cdk.Tags.of(stage).add('ManagedBy', 'CDK');
