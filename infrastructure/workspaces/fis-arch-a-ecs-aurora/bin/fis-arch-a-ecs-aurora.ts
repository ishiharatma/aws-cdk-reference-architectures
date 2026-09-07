#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { params } from 'parameters/environments';
import 'parameters'; // registers env params as side effects

import { FisChaosStage } from 'lib/stages/fis-chaos-stage';

const app = new cdk.App();

const pjName: string = process.env.PROJECT_NAME || app.node.tryGetContext('project');
const envName: Environment =
    (process.env.ENV as Environment) ||
    app.node.tryGetContext('env') ||
    Environment.DEVELOPMENT;

const defaultEnv = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
};

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName]!;

// Always allow deletion for this chaos-test workspace — it is meant to be
// provisioned for a test window then torn down, never kept long-running.
const isAutoDeleteObject = true;
const isTerminationProtection = false;

const stage = new FisChaosStage(app, `FisChaos${pascalCase(envName)}`, {
    project: pjName,
    environment: envName,
    env: defaultEnv,
    terminationProtection: isTerminationProtection,
    isAutoDeleteObject,
    params: envParams,
});

cdk.Tags.of(stage).add('Project', pjName);
cdk.Tags.of(stage).add('Environment', envName);
cdk.Tags.of(stage).add('ManagedBy', 'CDK');
cdk.Tags.of(stage).add('UseCase', 'FIS-ChaosEngineering');
