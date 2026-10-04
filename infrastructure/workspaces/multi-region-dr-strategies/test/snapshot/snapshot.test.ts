/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { MultiRegionDrStrategiesStage } from 'lib/stages/multi-region-dr-strategies-stage';
import { params } from 'parameters/environments';
import '../parameters';

const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

describe('Stack Snapshot Tests', () => {
  const app = new cdk.App();
  const stage = new MultiRegionDrStrategiesStage(app, 'Stage', {
    project: 'TestProject',
    environment: envName,
    env: { account: '123456789012', region: envParams.primaryRegion },
    isAutoDeleteObject: true,
    terminationProtection: false,
    params: envParams,
    includeRecoveryStack: true,
  });
  const assembly = app.synth().getNestedAssembly(stage.artifactId);
  const stacks = assembly.stacks.map((s) => [s.stackName, Template.fromJSON(s.template).toJSON()] as const);

  test.each(stacks)('Complete CloudFormation template snapshot: %s', (_name, template) => {
    expect(template).toMatchSnapshot();
  });

  test('Resource types and counts per stack', () => {
    const counts: Record<string, Record<string, number>> = {};
    stacks.forEach(([name, template]) => {
      counts[name] = {};
      Object.values(template.Resources || {}).forEach((resource: any) => {
        counts[name][resource.Type] = (counts[name][resource.Type] || 0) + 1;
      });
    });
    expect(counts).toMatchSnapshot();
  });
});
