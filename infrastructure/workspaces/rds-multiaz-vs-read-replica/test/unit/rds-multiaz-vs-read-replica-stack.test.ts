/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { RdsMultiazVsReadReplicaStack } from 'lib/stacks/rds-multiaz-vs-read-replica-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const build = (isAutoDeleteObject = true) => {
  const app = new cdk.App();
  const stack = new RdsMultiazVsReadReplicaStack(app, 'RdsMultiazVsReadReplica', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject,
    env: testEnv,
    params: envParams,
  });
  return Template.fromStack(stack);
};

describe('RdsMultiazVsReadReplicaStack', () => {
  const template = build();
  const instance = (id: string) => (Object.values(template.findResources('AWS::RDS::DBInstance', {
    Properties: { DBInstanceIdentifier: id },
  })) as any[])[0];

  describe('the two instances', () => {
    test('the primary is a Multi-AZ instance with automated backups, which a replica requires', () => {
      const primary = instance('test-test-rdscmp-primary');
      expect(primary.Properties.MultiAZ).toBe(true);
      expect(primary.Properties.BackupRetentionPeriod).toBeGreaterThanOrEqual(1);
      expect(primary.Properties.StorageEncrypted).toBe(true);
    });

    test('the replica is a single-AZ read replica of the primary, encrypted, with no credentials of its own', () => {
      const replica = instance('test-test-rdscmp-replica');
      expect(replica.Properties.SourceDBInstanceIdentifier).toBeDefined();
      expect(replica.Properties.MultiAZ).toBe(false);
      expect(replica.Properties.StorageEncrypted).toBe(true);
      expect(replica.Properties.MasterUsername).toBeUndefined();
    });

    test('both use the same instance class and neither is publicly accessible', () => {
      template.resourceCountIs('AWS::RDS::DBInstance', 2);
      Object.values(template.findResources('AWS::RDS::DBInstance')).forEach((i: any) => {
        expect(i.Properties.DBInstanceClass).toBe(envParams.dbInstanceClass);
        expect(i.Properties.PubliclyAccessible).toBe(false);
      });
    });

    test('development removes the instances, production snapshots them and protects them from deletion', () => {
      Object.values(template.findResources('AWS::RDS::DBInstance')).forEach((i: any) => {
        expect(i.DeletionPolicy).toBe('Delete');
        expect(i.Properties.DeletionProtection).toBe(false);
      });
      Object.values(build(false).findResources('AWS::RDS::DBInstance')).forEach((i: any) => {
        expect(i.DeletionPolicy).toBe('Snapshot');
        expect(i.Properties.DeletionProtection).toBe(true);
      });
    });
  });

  describe('network', () => {
    test('the VPC has isolated subnets only, no NAT gateway and no internet gateway', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      template.resourceCountIs('AWS::EC2::InternetGateway', 0);
    });

    test('Secrets Manager is reached through an interface endpoint', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Interface', ServiceName: Match.stringLikeRegexp('secretsmanager') });
    });

    test('the database security group accepts PostgreSQL from the probe group only', () => {
      const ingress = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress', { Properties: { FromPort: 5432 } })) as any[];
      expect(ingress).toHaveLength(1);
      expect(ingress[0].Properties.SourceSecurityGroupId).toBeDefined();
      expect(ingress[0].Properties.CidrIp).toBeUndefined();
    });
  });

  describe('probe and alarm', () => {
    test('the probe runs in the VPC with both endpoints and the secret in its environment', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-test-rdscmp-probe',
        Architectures: ['arm64'],
        VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
        Environment: { Variables: Match.objectLike({ SECRET_ARN: Match.anyValue(), PRIMARY_ENDPOINT: Match.anyValue(), REPLICA_ENDPOINT: Match.anyValue() }) },
      });
    });

    test('a heartbeat runs every minute so that ReplicaLag does not grow on an idle primary', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'test-test-rdscmp-heartbeat',
        ScheduleExpression: 'rate(1 minute)',
        Targets: [Match.objectLike({ Input: JSON.stringify({ action: 'heartbeat' }) })],
      });
    });

    test('the replica lag alarm uses the threshold from the parameters', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'ReplicaLag',
        Namespace: 'AWS/RDS',
        Threshold: envParams.replicaLagAlarmSeconds,
        Statistic: 'Maximum',
      });
    });
  });
});
