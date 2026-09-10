import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
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

describe('Stack Snapshot Tests', () => {
  const context = { ...baseContext, 'aws:cdk:bundling-stacks': [] };
  const app = new cdk.App({ context });

  const baseStack = new BaseStack(app, 'Base', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    vpcConfig: envParams.vpcConfig,
    allowedIpsforAlb: ['0.0.0.0/0'],
  });

  const dbStack = new DatabaseStack(app, 'Database', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    vpc: baseStack.vpcConstruct.vpc,
    dbSg: baseStack.dbSg,
    auroraConfig: envParams.auroraConfig,
  });

  const keycloakStack = new KeycloakStack(app, 'Keycloak', {
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

  const appStack = new AppStack(app, 'App', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    vpc: baseStack.vpcConstruct.vpc,
    albSg: baseStack.appAlbSg,
    appEcsSg: baseStack.appEcsSg,
    oidcConfig: envParams.oidcConfig,
    keycloakBaseUrl: 'http://keycloak.example.com',
    keycloakRealmName: envParams.keycloakConfig.realmName,
    isAlbOpen: true,
  });

  test('BaseStack matches snapshot', () => {
    expect(Template.fromStack(baseStack).toJSON()).toMatchSnapshot();
  });

  test('DatabaseStack matches snapshot', () => {
    expect(Template.fromStack(dbStack).toJSON()).toMatchSnapshot();
  });

  test('KeycloakStack matches snapshot', () => {
    expect(Template.fromStack(keycloakStack).toJSON()).toMatchSnapshot();
  });

  test('AppStack matches snapshot', () => {
    expect(Template.fromStack(appStack).toJSON()).toMatchSnapshot();
  });
});
