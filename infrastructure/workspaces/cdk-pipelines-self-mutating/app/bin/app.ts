#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PipelineStack } from '../lib/pipeline-stack';
import { pipelineStackName } from '../lib/naming';

const app = new cdk.App();

// Passed as `-c project=... -c env=...` on the first deploy; the pipeline's synth step repeats them.
const project: string | undefined = app.node.tryGetContext('project');
const environment: string | undefined = app.node.tryGetContext('env');
if (!project || !environment) {
  throw new Error('Context "project" and "env" are required, e.g. cdk deploy -c project=myproject -c env=dev');
}

new PipelineStack(app, 'Pipeline', {
  stackName: pipelineStackName(project, environment),
  description: `CDK Pipelines self-mutating pipeline (${project}/${environment})`,
  project,
  environment,
  isAutoDeleteObject: environment !== 'prd',
  // Resolved from the credentials in use (laptop on first deploy, CodeBuild on self-mutation).
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

cdk.Tags.of(app).add('Project', project);
cdk.Tags.of(app).add('Environment', environment);
cdk.Tags.of(app).add('ManagedBy', 'CDK');
