#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { S3AmplifyStaticWebsiteStage } from 'lib/stages/s3-amplify-static-website-stage';

const app = new cdk.App();

const pjName: string = app.node.tryGetContext('project');
const envName: Environment = app.node.tryGetContext('env') || Environment.DEVELOPMENT;

const defaultEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

console.log(`Project Name: ${pjName}`);
console.log(`Environment Name: ${envName}`);

const isAutoDeleteObject = true;
const isTerminationProtection = false;

const stage = new S3AmplifyStaticWebsiteStage(
  app,
  `S3AmplifyStaticWebsite${pascalCase(envName)}`,
  {
    project: pjName,
    environment: envName,
    env: defaultEnv,
    terminationProtection: isTerminationProtection,
    isAutoDeleteObject,
  },
);

cdk.Tags.of(stage).add('Project', pjName);
cdk.Tags.of(stage).add('Environment', envName);
cdk.Tags.of(stage).add('ManagedBy', 'CDK');
