#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { getMyGlobalIp } from "@common/helpers/get-my-ip";
import { params } from 'parameters/environments';
import 'parameters'; // registers dev-params into `params` as a side effect

import { CloudfrontVpcOriginStack } from 'lib/stacks/cloudfront-vpc-origin-stack';
import { CloudfrontLogDeliveryStack } from 'lib/stacks/cloudfront-log-delivery-stack';
import { CloudfrontMonitoringStack } from 'lib/stacks/cloudfront-monitoring-stack';

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

// Whether to force delete an S3 bucket even if objects exist
// Determine by environment identifier
//const isAutoDeleteObject:boolean = envName.match(/^(dev|test|stage)$/) ? true: false;
// Since it is a test, it can be deleted
const isAutoDeleteObject = true;

// Before you can use cdk destroy to delete a deletion-protected stack, you must disable deletion protection for the stack in the management console.
// const isTerminationProtection:boolean = envName.match(/^(dev|test)$/) ? false: true;
// Since it is a test, it can be deleted
const isTerminationProtection = false;

const mainStack = new CloudfrontVpcOriginStack(app, pascalCase(`${pjName}-${envName}`), {
  project: pjName,
  description: `${pascalCase(pjName)} Cloudfront VPC Origin Stack for ${envName}`,
  environment: envName,
  vpcConfig: envParams.vpcConfig,
  cloudfrontManagedPrefixList: envParams.cloudfrontManagedPrefixList,
  publicAlbFailover: envParams.publicAlbFailover,
  allowedIps: [getMyGlobalIp()],
  env: defaultEnv,
  terminationProtection: isTerminationProtection, // Enabling deletion protection
  isAutoDeleteObject: isAutoDeleteObject,
  crossRegionReferences: true,
});

// CloudFront standard logging (v2) delivery (log group + source + destination + pairing) must
// all live in us-east-1: PutDeliverySource for CloudFront only works there, and CloudWatch Logs
// delivery destinations don't support cross-region delivery at all. So this is a single stack,
// separate from the main stack purely because of that region requirement.
if (mainStack.hasDenyAccessFunction) {
  const logDeliveryStack = new CloudfrontLogDeliveryStack(app, pascalCase(`${pjName}-${envName}-log-delivery`), {
    project: pjName,
    description: `${pascalCase(pjName)} CloudFront Log Delivery Stack for ${envName}`,
    environment: envName,
    distributionArn: mainStack.distribution.distributionArn,
    env: { account: defaultEnv.account, region: 'us-east-1' },
    terminationProtection: isTerminationProtection,
    isAutoDeleteObject: isAutoDeleteObject,
    crossRegionReferences: true,
  });
  logDeliveryStack.addDependency(mainStack);
}

// CloudFront's request/error metrics (namespace AWS/CloudFront) are only published to us-east-1
// regardless of the distribution's own region, and a CloudWatch Alarm can only evaluate a metric
// in its own region — so this, too, is a separate stack forced into us-east-1. Always created
// (unlike the log delivery stack above) so the 5xx error rate alarm exists regardless of whether
// the viewer IP allow-list feature is in use.
const monitoringStack = new CloudfrontMonitoringStack(app, pascalCase(`${pjName}-${envName}-monitoring`), {
  project: pjName,
  description: `${pascalCase(pjName)} CloudFront Monitoring Stack for ${envName}`,
  environment: envName,
  distributionId: mainStack.distribution.distributionId,
  alarmEmail: envParams.alarmEmail,
  env: { account: defaultEnv.account, region: 'us-east-1' },
  terminationProtection: isTerminationProtection,
  crossRegionReferences: true,
});
monitoringStack.addDependency(mainStack);

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(app).add("Project", pjName);
cdk.Tags.of(app).add("Environment", envName);
cdk.Tags.of(app).add("ManagedBy", "CDK");