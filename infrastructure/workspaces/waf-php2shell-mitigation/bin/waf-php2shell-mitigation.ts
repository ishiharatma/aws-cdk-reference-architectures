#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { getMyGlobalIp, getMyGlobalIpv6 } from "@common/helpers/get-my-ip";
import { params } from 'parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters'; // registers dev-params into `params` as a side effect

import { WafPhp2ShellMitigationStage } from 'lib/stages/waf-php2shell-mitigation-stage';

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

// Whether to force delete an S3 bucket even if objects exist
// Determine by environment identifier
//const isAutoDeleteObject:boolean = envName.match(/^(dev|test|stage)$/) ? true: false;
// Since it is a test, it can be deleted
const isAutoDeleteObject = true;

// Before you can use cdk destroy to delete a deletion-protected stack, you must disable deletion protection for the stack in the management console.
// const isTerminationProtection:boolean = envName.match(/^(dev|test)$/) ? false: true;
// Since it is a test, it can be deleted
const isTerminationProtection = false;

// Verification client IPs. They are allow-listed on the CloudFront Web ACL (default action BLOCK)
// and may also reach the ALB directly, which is how the ALB's fixed 8 KB inspection limit is
// compared with CloudFront's. Set `ALLOWED_IPS=1.2.3.4,5.6.7.8` to override; otherwise the
// deploying machine's global IP is used. IPv6 is best-effort (CloudFront allowlist only).
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

const stage = new WafPhp2ShellMitigationStage(app, `WafPhp2ShellMitigation${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection, // Enabling deletion protection
  isAutoDeleteObject: isAutoDeleteObject,
  params: envParams,
  allowedIps,
  allowedIpv6s,
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add("Project", pjName);
cdk.Tags.of(stage).add("Environment", envName);
cdk.Tags.of(stage).add("ManagedBy", "CDK");
