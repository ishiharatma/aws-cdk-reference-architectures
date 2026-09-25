/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { SecretsRotationAuroraStack } from 'lib/stacks/secrets-rotation-aurora-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const build = (isAutoDeleteObject = true) => {
  const app = new cdk.App();
  const stack = new SecretsRotationAuroraStack(app, 'SecretsRotationAurora', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject,
    env: testEnv,
    params: envParams,
  });
  return Template.fromStack(stack);
};

describe('SecretsRotationAuroraStack', () => {
  const template = build();
  const schedules = () => Object.values(template.findResources('AWS::SecretsManager::RotationSchedule')) as any[];

  describe('network', () => {
    test('isolated subnets only: no NAT gateway, no internet gateway', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      template.resourceCountIs('AWS::EC2::InternetGateway', 0);
      template.resourceCountIs('AWS::EC2::Subnet', 2);
    });

    test('a Secrets Manager interface endpoint lets the in-VPC rotation functions reach the API', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        ServiceName: 'com.amazonaws.ap-northeast-1.secretsmanager',
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
      });
    });

    test('rejected traffic is logged', () => {
      template.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'REJECT' });
    });
  });

  describe('Aurora', () => {
    test('encrypted Serverless v2 PostgreSQL 16 with the Data API, in the isolated subnets', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        Engine: 'aurora-postgresql',
        EngineVersion: Match.stringLikeRegexp('^16\\.'),
        StorageEncrypted: true,
        EnableHttpEndpoint: true,
        ServerlessV2ScalingConfiguration: { MinCapacity: envParams.minCapacity, MaxCapacity: envParams.maxCapacity },
        DatabaseName: envParams.databaseName,
      });
      template.hasResourceProperties('AWS::RDS::DBInstance', { DBInstanceClass: 'db.serverless' });
    });

    test('deletion protection follows the environment', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', { DeletionProtection: false });
      build(false).hasResourceProperties('AWS::RDS::DBCluster', { DeletionProtection: true });
    });

    test('the database accepts connections only from the rotation security group', () => {
      const ingress = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')) as any[];
      // Two ingress rules exist: 443 to the Secrets Manager endpoint and the (token) database port; both come from the rotation SG.
      expect(ingress).toHaveLength(2);
      ingress.forEach((i) => expect(JSON.stringify(i.Properties.SourceSecurityGroupId)).toContain('RotationSecurityGroup'));
      expect(ingress.filter((i) => JSON.stringify(i.Properties.FromPort).includes('Endpoint.Port'))).toHaveLength(1);
    });
  });

  describe('secrets and rotation', () => {
    test('two rotation schedules, each on the configured interval and not rotating at deploy time', () => {
      expect(schedules()).toHaveLength(2);
      schedules().forEach((s) => {
        expect(s.Properties.RotationRules.ScheduleExpression).toBe(`rate(${envParams.rotationDays} days)`);
        expect(s.Properties.RotateImmediatelyOnUpdate).toBe(false);
      });
    });

    test('the master secret uses single-user rotation; the app secret uses alternating users', () => {
      const types = schedules().map((s) => s.Properties.HostedRotationLambda.RotationType).sort();
      expect(types).toEqual(['PostgreSQLMultiUser', 'PostgreSQLSingleUser']);
      const multi = schedules().find((s) => s.Properties.HostedRotationLambda.RotationType === 'PostgreSQLMultiUser');
      expect(multi.Properties.HostedRotationLambda.MasterSecretArn).toBeDefined();
    });

    test('hosted rotation functions run in the isolated subnets with the rotation security group', () => {
      schedules().forEach((s) => {
        expect(s.Properties.HostedRotationLambda.VpcSubnetIds).toBeDefined();
        expect(s.Properties.HostedRotationLambda.VpcSecurityGroupIds).toBeDefined();
      });
    });

    test('secrets are named by the convention the check script relies on', () => {
      template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'test-test-rot/master' });
      template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'test-test-rot/app' });
    });

    test('the app secret targets its own database user and is attached to the cluster', () => {
      const app = (Object.values(template.findResources('AWS::SecretsManager::Secret')) as any[]).find((r) => r.Properties.Name === 'test-test-rot/app');
      // `masterarn` is what lets the multi-user rotation function find the credentials it clones users with.
      const secretTemplate = JSON.stringify(app.Properties.GenerateSecretString.SecretStringTemplate);
      expect(secretTemplate).toContain(`\\"username\\":\\"${envParams.appUsername}\\"`);
      expect(secretTemplate).toContain('masterarn');
      template.resourceCountIs('AWS::SecretsManager::SecretTargetAttachment', 2);
    });
  });

  describe('sample consumer', () => {
    test('the function is not in the VPC and reads the secret through the Data API', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-test-rot-whoami',
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
      });
      const fn = (Object.values(template.findResources('AWS::Lambda::Function')) as any[]).find((f) => f.Properties.FunctionName === 'test-test-rot-whoami');
      expect(fn.Properties.VpcConfig).toBeUndefined();
    });

    test('least privilege: ExecuteStatement on the cluster, GetSecretValue on the app secret only', () => {
      const policies = (Object.values(template.findResources('AWS::IAM::Policy')) as any[])
        .filter((p) => JSON.stringify(p.Properties.Roles).includes('Whoami'))
        .flatMap((p) => p.Properties.PolicyDocument.Statement);
      const actions = policies.flatMap((s) => [].concat(s.Action)).filter((a: string) => a.startsWith('rds-data:') || a.startsWith('secretsmanager:'));
      expect(actions.sort()).toEqual(['rds-data:ExecuteStatement', 'secretsmanager:GetSecretValue']);
    });
  });

  test('outputs the values used by test-rotation.sh', () => {
    const outputs = Object.keys(template.toJSON().Outputs);
    ['ClusterArn', 'MasterSecretArn', 'AppSecretArn', 'DatabaseName', 'AppUsername', 'WhoamiFunctionName'].forEach((n) => expect(outputs).toContain(n));
  });
});
