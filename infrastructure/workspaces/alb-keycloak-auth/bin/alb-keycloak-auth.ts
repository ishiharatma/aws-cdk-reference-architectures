#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AlbKeycloakAuthStage } from 'lib/stages/alb-keycloak-auth-stage';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { validateDeployment } from '@common/helpers/validate-deployment';
import { getMyGlobalIpCidr } from '@common/helpers/get-my-ip';
import { params } from 'parameters/environments';

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

validateDeployment(pjName, envName, envParams.accountId);

const isAutoDeleteObject = true;
const isTerminationProtection = false;

const stage = new AlbKeycloakAuthStage(app, `AlbKeycloakAuth${pascalCase(envName)}`, {
  project: pjName,
  environment: envName,
  env: defaultEnv,
  terminationProtection: isTerminationProtection,
  isAutoDeleteObject,
  params: envParams,
  allowedIpsforAlb: [getMyGlobalIpCidr()],
});

cdk.Tags.of(stage).add('Project', pjName);
cdk.Tags.of(stage).add('Environment', envName);
cdk.Tags.of(stage).add('ManagedBy', 'CDK');
