#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { getMyGlobalIp, getMyGlobalIpv6 } from "@common/helpers/get-my-ip";
import { params } from 'parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters'; // registers dev-params into `params` as a side effect

import { CicdCloudfrontS3Stage } from 'lib/stages/cicd-cloudfront-s3-stage';

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

// WAF allowlist IPs to permit alongside the managed rules. Prefer explicit env vars
// (comma-separated, e.g. `ALLOWED_IPS=1.2.3.4,5.6.7.8`) when set — useful when the deploying
// machine's own detected IP isn't the one you actually want to allow (e.g. deploying from a
// devcontainer but browsing from your laptop). Falls back to auto-detecting this machine's own
// global IP when the env var is unset. IPv6 is best-effort even in the fallback case: many deploy
// environments (CI runners, some devcontainers) have no IPv6 egress, in which case it resolves to
// `undefined` and only the IPv4 allowlist is applied.
const parseIpListEnv = (value: string | undefined): string[] | undefined => {
  const ips = value?.split(',').map(ip => ip.trim()).filter(Boolean);
  return ips && ips.length > 0 ? ips : undefined;
};

const allowedIps = parseIpListEnv(process.env.ALLOWED_IPS) ?? [getMyGlobalIp()];
console.log(`IPv4s: ${allowedIps?.join(', ') ?? 'none'}`);
const allowedIpv6s = parseIpListEnv(process.env.ALLOWED_IPV6S) ?? (() => {
  const myIpv6 = getMyGlobalIpv6();
  return myIpv6 ? [myIpv6] : undefined;
})();

console.log(`IPv6s: ${allowedIpv6s?.join(', ') ?? 'none'}`);

const stage = new CicdCloudfrontS3Stage(app, `CicdCloudfrontS3${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection, // Enabling deletion protection
  isAutoDeleteObject: isAutoDeleteObject,
  params: envParams,
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add("Project", pjName);
cdk.Tags.of(stage).add("Environment", envName);
cdk.Tags.of(stage).add("ManagedBy", "CDK");
