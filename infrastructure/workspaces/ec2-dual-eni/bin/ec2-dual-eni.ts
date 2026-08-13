#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import { getMyGlobalIpCidr } from '@common/helpers/get-my-ip';
import { params } from 'parameters/environments';
import 'parameters';

import { Ec2DualEniStage } from 'lib/stages/ec2-dual-eni-stage';

const app = new cdk.App();

const pjName: string = process.env.PROJECT_NAME || app.node.tryGetContext('project');
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

const isAutoDeleteObject = true;
const isTerminationProtection = false;

// Resolve management-allowed CIDRs: explicit env var (comma-separated) or auto-detect
const parseIpListEnv = (value: string | undefined): string[] | undefined => {
  const ips = value?.split(',').map((ip) => ip.trim()).filter(Boolean);
  return ips && ips.length > 0 ? ips : undefined;
};
const managementAllowedCidrs =
  parseIpListEnv(process.env.MANAGEMENT_ALLOWED_CIDRS) ??
  envParams.managementAllowedCidrs.length
    ? envParams.managementAllowedCidrs
    : [getMyGlobalIpCidr()];

// Resolve web-allowed CIDRs.
// Default: deployer's own IP only (safety guard — prevents accidental full-internet exposure).
// Set WEB_ALLOWED_CIDRS=0.0.0.0/0 to open to all internet as the pattern intends.
const webAllowedCidrs = parseIpListEnv(process.env.WEB_ALLOWED_CIDRS) ?? [getMyGlobalIpCidr()];

console.log(`Management allowed CIDRs: ${managementAllowedCidrs.join(', ')}`);
console.log(`Web allowed CIDRs:        ${webAllowedCidrs.join(', ')}`);

new Ec2DualEniStage(app, `Ec2DualEni${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection,
  isAutoDeleteObject: isAutoDeleteObject,
  params: envParams,
  managementAllowedCidrs,
  webAllowedCidrs,
});

cdk.Tags.of(app).add('Project', pjName);
cdk.Tags.of(app).add('Environment', envName);
cdk.Tags.of(app).add('ManagedBy', 'CDK');
