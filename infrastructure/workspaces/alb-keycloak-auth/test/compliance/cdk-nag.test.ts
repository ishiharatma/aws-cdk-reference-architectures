import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { BaseStack } from 'lib/stacks/base-stack';
import { DatabaseStack } from 'lib/stacks/database-stack';
import { KeycloakStack } from 'lib/stacks/keycloak-stack';
import { AppStack } from 'lib/stacks/app-stack';
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

/**
 * CDK Nag Compliance Tests
 *
 * Documents accepted deviations from AWS Solutions security rules in the test
 * environment. All suppressions carry an explicit reason. Production deployments
 * should revisit each suppression before going live.
 *
 * Accepted deviations (test env):
 *   VPC7  — Flow Logs disabled (cost optimization)
 *   EC26/28/29 — NAT instance used instead of NAT Gateway
 *   IAM5  — Wildcard permissions on ECS execution/task roles
 *   ELB2  — ALB access logging disabled
 *   ECS2  — Plaintext environment variables for Keycloak KC_* settings
 *   SMG4  — Secrets rotation not configured (manual rotation via scripts)
 */
describe('CDK Nag Compliance Tests', () => {
  describe('BaseStack Compliance', () => {
    let baseStack: BaseStack;

    beforeAll(() => {
      const context = { ...baseContext, 'aws:cdk:bundling-stacks': [] };
      const app = new cdk.App({ context });

      baseStack = new BaseStack(app, 'Base', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpcConfig: envParams.vpcConfig,
        allowedIpsforAlb: ['0.0.0.0/0'],
      });

      NagSuppressions.addStackSuppressions(
        baseStack,
        [
          {
            id: 'AwsSolutions-VPC7',
            reason: 'VPC Flow Logs disabled for cost optimization in test environment.',
          },
          {
            id: 'AwsSolutions-EC26',
            reason: 'NAT instance EBS not encrypted; acceptable for test environment.',
          },
          {
            id: 'AwsSolutions-EC28',
            reason: 'NAT instance detailed monitoring disabled; acceptable for test environment.',
          },
          {
            id: 'AwsSolutions-EC29',
            reason: 'NAT instance termination protection disabled; acceptable for test environment.',
          },
          {
            id: 'AwsSolutions-EC23',
            reason: 'ALB security group allows all IPv4 ingress (allowedIpsforAlb=[0.0.0.0/0]). Restrict in production via allowedIpsforAlb.',
          },
        ],
        true,
      );

      cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test('No unsuppressed Errors', () => {
      const errors = Annotations.fromStack(baseStack).findError(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*'),
      );
      if (errors.length > 0) {
        console.log('\nBaseStack unsuppressed errors:');
        errors.forEach((e) => console.log(' ', e.id, e.entry.data));
      }
      expect(errors).toHaveLength(0);
    });
  });

  describe('DatabaseStack Compliance', () => {
    let baseStack: BaseStack;
    let dbStack: DatabaseStack;

    beforeAll(() => {
      const context = { ...baseContext, 'aws:cdk:bundling-stacks': [] };
      const app = new cdk.App({ context });

      baseStack = new BaseStack(app, 'Base', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpcConfig: envParams.vpcConfig,
      });

      dbStack = new DatabaseStack(app, 'Database', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpc: baseStack.vpcConstruct.vpc,
        dbSg: baseStack.dbSg,
        auroraConfig: envParams.auroraConfig,
      });

      NagSuppressions.addStackSuppressions(
        baseStack,
        [
          { id: 'AwsSolutions-VPC7', reason: 'Flow Logs disabled in test environment.' },
          { id: 'AwsSolutions-EC26', reason: 'NAT instance; test environment.' },
          { id: 'AwsSolutions-EC28', reason: 'NAT instance; test environment.' },
          { id: 'AwsSolutions-EC29', reason: 'NAT instance; test environment.' },
          { id: 'AwsSolutions-EC23', reason: 'ALB SGs use 0.0.0.0/0 in test; restrict via allowedIpsforAlb in production.' },
        ],
        true,
      );

      NagSuppressions.addStackSuppressions(
        dbStack,
        [
          {
            id: 'AwsSolutions-SMG4',
            reason: 'DB credentials rotation managed manually via scripts/keycloak-setup.sh.',
          },
          {
            id: 'AwsSolutions-RDS6',
            reason: 'IAM DB auth not supported for Keycloak; credentials via Secrets Manager.',
          },
          {
            id: 'AwsSolutions-RDS10',
            reason: 'Deletion protection disabled in test environment (isAutoDeleteObject=true).',
          },
          {
            id: 'AwsSolutions-RDS16',
            reason: 'Backtrack not supported for Aurora Serverless V2 PostgreSQL.',
          },
          {
            id: 'AwsSolutions-IAM4',
            reason: 'CDK auto-generated log retention Lambda uses AWSLambdaBasicExecutionRole; acceptable.',
            appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason: 'CDK auto-generated log retention Lambda requires wildcard permissions.',
            appliesTo: ['Resource::*'],
          },
        ],
        true,
      );

      cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test('No unsuppressed Errors', () => {
      const errors = Annotations.fromStack(dbStack).findError(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*'),
      );
      if (errors.length > 0) {
        console.log('\nDatabaseStack unsuppressed errors:');
        errors.forEach((e) => console.log(' ', e.id, e.entry.data));
      }
      expect(errors).toHaveLength(0);
    });
  });

  describe('KeycloakStack Compliance', () => {
    let baseStack: BaseStack;
    let dbStack: DatabaseStack;
    let keycloakStack: KeycloakStack;

    beforeAll(() => {
      const context = { ...baseContext, 'aws:cdk:bundling-stacks': [] };
      const app = new cdk.App({ context });

      baseStack = new BaseStack(app, 'Base', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpcConfig: envParams.vpcConfig,
      });

      dbStack = new DatabaseStack(app, 'Database', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpc: baseStack.vpcConstruct.vpc,
        dbSg: baseStack.dbSg,
        auroraConfig: envParams.auroraConfig,
      });

      keycloakStack = new KeycloakStack(app, 'Keycloak', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpc: baseStack.vpcConstruct.vpc,
        albSg: baseStack.keycloakAlbSg,
        keycloakEcsSg: baseStack.keycloakEcsSg,
        auroraCluster: dbStack.cluster,
        auroraSecret: dbStack.secret,
        keycloakConfig: envParams.keycloakConfig,
        isAlbOpen: true,
      });

      NagSuppressions.addStackSuppressions(
        baseStack,
        [
          { id: 'AwsSolutions-VPC7', reason: 'Flow Logs disabled in test environment.' },
          { id: 'AwsSolutions-EC26', reason: 'NAT instance; test environment.' },
          { id: 'AwsSolutions-EC28', reason: 'NAT instance; test environment.' },
          { id: 'AwsSolutions-EC29', reason: 'NAT instance; test environment.' },
          { id: 'AwsSolutions-EC23', reason: 'ALB SGs accept all IPv4 in test; restrict via allowedIpsforAlb in production.' },
        ],
        true,
      );

      NagSuppressions.addStackSuppressions(
        dbStack,
        [
          { id: 'AwsSolutions-SMG4', reason: 'Manual rotation via setup scripts.' },
          { id: 'AwsSolutions-RDS6', reason: 'IAM auth not applicable for Keycloak.' },
          { id: 'AwsSolutions-RDS10', reason: 'Test environment, deletion protection off.' },
          { id: 'AwsSolutions-RDS16', reason: 'Backtrack not supported on Aurora Serverless V2.' },
          {
            id: 'AwsSolutions-IAM4',
            reason: 'CDK auto-generated log retention Lambda uses AWSLambdaBasicExecutionRole.',
            appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason: 'CDK auto-generated log retention Lambda requires wildcard permissions.',
            appliesTo: ['Resource::*'],
          },
        ],
        true,
      );

      NagSuppressions.addStackSuppressions(
        keycloakStack,
        [
          {
            id: 'AwsSolutions-ELB2',
            reason: 'ALB access logging disabled for cost optimization in test environment.',
          },
          {
            id: 'AwsSolutions-ECS2',
            reason:
              'Keycloak KC_* configuration uses plaintext environment variables. Credentials are injected via Secrets Manager; only non-sensitive config is plaintext.',
          },
          {
            id: 'AwsSolutions-IAM4',
            reason: 'ECS execution role uses AmazonECSTaskExecutionRolePolicy (AWS managed); acceptable for this workload.',
            appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason: 'ECS execution role requires wildcard permissions for CloudWatch Logs and ECR.',
            appliesTo: ['Resource::*'],
          },
          {
            id: 'AwsSolutions-SMG4',
            reason: 'Admin secret rotation managed manually after initial Keycloak setup.',
          },
        ],
        true,
      );

      cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test('No unsuppressed Errors', () => {
      const errors = Annotations.fromStack(keycloakStack).findError(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*'),
      );
      if (errors.length > 0) {
        console.log('\nKeycloakStack unsuppressed errors:');
        errors.forEach((e) => console.log(' ', e.id, e.entry.data));
      }
      expect(errors).toHaveLength(0);
    });
  });

  describe('AppStack Compliance', () => {
    let baseStack: BaseStack;
    let appStack: AppStack;

    beforeAll(() => {
      const context = { ...baseContext, 'aws:cdk:bundling-stacks': [] };
      const app = new cdk.App({ context });

      baseStack = new BaseStack(app, 'Base', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpcConfig: envParams.vpcConfig,
      });

      appStack = new AppStack(app, 'App', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpc: baseStack.vpcConstruct.vpc,
        albSg: baseStack.appAlbSg,
        appEcsSg: baseStack.appEcsSg,
        oidcConfig: { ...envParams.oidcConfig, enabled: false },
        keycloakBaseUrl: 'http://keycloak.example.com',
        keycloakRealmName: envParams.keycloakConfig.realmName,
        isAlbOpen: true,
      });

      NagSuppressions.addStackSuppressions(
        baseStack,
        [
          { id: 'AwsSolutions-VPC7', reason: 'Flow Logs disabled in test environment.' },
          { id: 'AwsSolutions-EC26', reason: 'NAT instance; test environment.' },
          { id: 'AwsSolutions-EC28', reason: 'NAT instance; test environment.' },
          { id: 'AwsSolutions-EC29', reason: 'NAT instance; test environment.' },
        ],
        true,
      );

      NagSuppressions.addStackSuppressions(
        appStack,
        [
          {
            id: 'AwsSolutions-ELB2',
            reason: 'ALB access logging disabled for cost optimization in test environment.',
          },
          {
            id: 'AwsSolutions-IAM4',
            reason: 'ECS execution role uses AmazonECSTaskExecutionRolePolicy (AWS managed); acceptable for this workload.',
            appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason: 'ECS execution role requires wildcard permissions for CloudWatch Logs and ECR.',
            appliesTo: ['Resource::*'],
          },
          {
            id: 'AwsSolutions-SMG4',
            reason: 'OIDC client secret rotation managed manually after Keycloak setup.',
          },
        ],
        true,
      );

      cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test('No unsuppressed Errors', () => {
      const errors = Annotations.fromStack(appStack).findError(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*'),
      );
      if (errors.length > 0) {
        console.log('\nAppStack unsuppressed errors:');
        errors.forEach((e) => console.log(' ', e.id, e.entry.data));
      }
      expect(errors).toHaveLength(0);
    });
  });
});
