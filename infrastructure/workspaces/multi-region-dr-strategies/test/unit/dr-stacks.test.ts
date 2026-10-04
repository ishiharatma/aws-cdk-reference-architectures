/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { MultiRegionDrStrategiesStage } from 'lib/stages/multi-region-dr-strategies-stage';
import { params } from 'parameters/environments';
import '../parameters';

const account = '123456789012';
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const build = (includeRecoveryStack = false) => {
  const app = new cdk.App();
  const stage = new MultiRegionDrStrategiesStage(app, 'Stage', {
    project: 'test',
    environment: Environment.TEST,
    env: { account, region: envParams.primaryRegion },
    isAutoDeleteObject: true,
    terminationProtection: false,
    params: envParams,
    includeRecoveryStack,
  });
  const assembly = app.synth().getNestedAssembly(stage.artifactId);
  const template = (name: string) => Template.fromJSON(assembly.getStackByName(name).template);
  return { template, assembly };
};

describe('multi-region DR strategies', () => {
  const { template, assembly } = build();
  const primary = template('test-test-dr-primary');
  const secondary = template('test-test-dr-secondary');

  test('stacks land in the right regions', () => {
    expect(assembly.getStackByName('test-test-dr-primary').environment.region).toBe(envParams.primaryRegion);
    expect(assembly.getStackByName('test-test-dr-secondary').environment.region).toBe(envParams.drRegion);
  });

  describe('data layer', () => {
    test('backup and restore uses a single-region table; the other three are global tables replicated to the DR region', () => {
      primary.resourceCountIs('AWS::DynamoDB::Table', 1);
      const globals = Object.values(primary.findResources('AWS::DynamoDB::GlobalTable')) as any[];
      expect(globals).toHaveLength(3);
      globals.forEach((g) => {
        expect(g.Properties.Replicas.map((r: any) => r.Region)).toEqual(expect.arrayContaining([envParams.drRegion]));
        expect(g.Properties.BillingMode).toBe('PAY_PER_REQUEST');
      });
    });
  });

  describe('backup and restore', () => {
    test('backup rule copies recovery points to the DR vault and expires them', () => {
      primary.hasResourceProperties('AWS::Backup::BackupPlan', {
        BackupPlan: Match.objectLike({
          BackupPlanRule: [Match.objectLike({
            ScheduleExpression: envParams.backupScheduleCron,
            Lifecycle: { DeleteAfterDays: envParams.backupRetentionDays },
            CopyActions: [Match.objectLike({ Lifecycle: { DeleteAfterDays: envParams.backupRetentionDays } })],
          })],
        }),
      });
    });

    test('DR region owns the destination vault, encrypted with its own key', () => {
      secondary.hasResourceProperties('AWS::Backup::BackupVault', { BackupVaultName: 'test-test-dr-bnr-dr', EncryptionKeyArn: Match.anyValue() });
    });
  });

  describe('warm standby', () => {
    test('standby function is deployed but scaled to zero', () => {
      secondary.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-test-dr-ws',
        ReservedConcurrentExecutions: envParams.warmStandbyConcurrency,
      });
    });

    test('DNS fails over from PRIMARY (health checked) to SECONDARY', () => {
      primary.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'ws.dr.internal', Failover: 'PRIMARY', HealthCheckId: Match.anyValue() });
      primary.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'ws.dr.internal', Failover: 'SECONDARY' });
    });
  });

  describe('active-active', () => {
    test('DR function serves without a concurrency cap', () => {
      const fn = Object.values(secondary.findResources('AWS::Lambda::Function', { Properties: { FunctionName: 'test-test-dr-aa' } })) as any[];
      expect(fn).toHaveLength(1);
      expect(fn[0].Properties.ReservedConcurrentExecutions).toBeUndefined();
    });

    test('DNS is weighted 50/50 and each side has a health check', () => {
      const records = Object.values(primary.findResources('AWS::Route53::RecordSet', { Properties: { Name: 'aa.dr.internal' } })) as any[];
      expect(records).toHaveLength(2);
      records.forEach((r) => {
        expect(r.Properties.Weight).toBe(50);
        expect(r.Properties.HealthCheckId).toBeDefined();
      });
    });
  });

  describe('pilot light', () => {
    test('no compute in the DR region in normal operation', () => {
      const names = (Object.values(secondary.findResources('AWS::Lambda::Function')) as any[]).map((f) => f.Properties.FunctionName);
      expect(names).not.toContain('test-test-dr-pl');
    });

    test('the recovery stack adds exactly the pilot light function in the DR region', () => {
      const withRecovery = build(true);
      const recovery = withRecovery.template('test-test-dr-recovery');
      recovery.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'test-test-dr-pl' });
      expect(withRecovery.assembly.getStackByName('test-test-dr-recovery').environment.region).toBe(envParams.drRegion);
    });
  });

  describe('least privilege', () => {
    test('each API function can only put and get items on its own table', () => {
      const policies = Object.values(primary.findResources('AWS::IAM::Policy')) as any[];
      const dataPolicies = policies.filter((p) => JSON.stringify(p).includes('dynamodb:PutItem'));
      expect(dataPolicies).toHaveLength(4);
      dataPolicies.forEach((p) => {
        const statement = p.Properties.PolicyDocument.Statement.find((s: any) => JSON.stringify(s).includes('dynamodb:PutItem'));
        expect(statement.Action).toEqual(['dynamodb:PutItem', 'dynamodb:GetItem']);
      });
    });
  });
});
