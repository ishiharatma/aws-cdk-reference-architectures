#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import { params } from 'parameters/environments';
import 'parameters'; // registers dev-params into `params` as a side effect
import { Route53PhzDelegationStage } from 'lib/stages/route53-phz-delegation-stage';

const app = new cdk.App();

// Get environment (specified in cdk.json context or at runtime with --context)
const pjName: string = process.env.PROJECT || app.node.tryGetContext('project');
const envName: Environment =
    (process.env.ENV as Environment) || app.node.tryGetContext('env') || Environment.DEVELOPMENT;

const envParams = params[envName];
if (!envParams) {
    throw new Error(`No parameters found for environment: ${envName}`);
}

validateDeployment(pjName, envName, envParams.accountId);

const defaultEnv = {
    account: process.env.CDK_DEFAULT_ACCOUNT || envParams.accountId,
    region: process.env.CDK_DEFAULT_REGION || envParams.region,
};

// Since this is a demonstration workspace, resources can always be deleted.
const isAutoDeleteObject = true;
const isTerminationProtection = envName === Environment.PRODUCTION;

const stage = new Route53PhzDelegationStage(app, `Route53PhzDelegation${pascalCase(envName)}`, {
    project: pjName,
    environment: envName,
    env: defaultEnv,
    terminationProtection: isTerminationProtection,
    isAutoDeleteObject: isAutoDeleteObject,
    params: envParams,
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add('Project', pjName);
cdk.Tags.of(stage).add('Environment', envName);
cdk.Tags.of(stage).add('ManagedBy', 'CDK');
