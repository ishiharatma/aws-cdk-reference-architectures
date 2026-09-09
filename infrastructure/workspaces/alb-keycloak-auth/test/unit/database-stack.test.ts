import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { BaseStack } from 'lib/stacks/base-stack';
import { DatabaseStack } from 'lib/stacks/database-stack';
import { params } from 'parameters/environments';
import '../parameters';
import * as path from 'path';
import { loadCdkContext } from '@common/test-helpers/test-context';

const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'testproject';
const envName: Environment = Environment.TEST;

if (!params[envName]) throw new Error(`No parameters for ${envName}`);
const envParams = params[envName]!;

const cdkJsonPath = path.resolve(__dirname, '../../cdk.json');
const baseContext = loadCdkContext(cdkJsonPath);

describe('DatabaseStack Unit Tests', () => {
  let template: Template;

  beforeAll(() => {
    const context = { ...baseContext, 'aws:cdk:bundling-stacks': [] };
    const app = new cdk.App({ context });
    const baseStack = new BaseStack(app, 'Base', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpcConfig: envParams.vpcConfig,
    });
    const stack = new DatabaseStack(app, 'Database', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpc: baseStack.vpcConstruct.vpc,
      dbSg: baseStack.dbSg,
      auroraConfig: envParams.auroraConfig,
    });
    template = Template.fromStack(stack);
  });

  describe('Secrets Manager', () => {
    test('creates one DatabaseSecret', () => {
      template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    });

    test('secret has correct name path', () => {
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: `/${projectName}/${envName}/aurora/credentials`,
      });
    });
  });

  describe('Aurora Serverless V2', () => {
    test('creates exactly one RDS cluster', () => {
      template.resourceCountIs('AWS::RDS::DBCluster', 1);
    });

    test('uses Aurora PostgreSQL engine', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        Engine: 'aurora-postgresql',
      });
    });

    test('uses PostgreSQL 16.4', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        EngineVersion: '16.4',
      });
    });

    test('has storage encrypted', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        StorageEncrypted: true,
      });
    });

    test('exports postgresql logs to CloudWatch', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        EnableCloudwatchLogsExports: Match.arrayWith(['postgresql']),
      });
    });

    test('uses Serverless V2 writer instance', () => {
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        DBInstanceClass: 'db.serverless',
      });
    });

    test('creates one DB subnet group (private subnets)', () => {
      template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
    });
  });

  describe('CloudFormation Outputs', () => {
    test('outputs Aurora endpoint', () => {
      template.hasOutput('AuroraEndpoint', {});
    });

    test('outputs Aurora secret ARN', () => {
      template.hasOutput('AuroraSecretArn', {});
    });

    test('outputs database name', () => {
      template.hasOutput('AuroraDatabaseName', {
        Value: envParams.auroraConfig.databaseName,
      });
    });
  });
});
