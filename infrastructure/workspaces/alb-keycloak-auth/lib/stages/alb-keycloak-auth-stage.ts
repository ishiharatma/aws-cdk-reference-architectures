import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { BaseStack } from 'lib/stacks/base-stack';
import { DatabaseStack } from 'lib/stacks/database-stack';
import { KeycloakStack } from 'lib/stacks/keycloak-stack';
import { AppStack } from 'lib/stacks/app-stack';

export interface AlbKeycloakAuthStageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
  readonly allowedIpsforAlb?: string[];
}

/**
 * Stage: ALB + Keycloak (ECS Fargate) + Aurora Serverless V2.
 *
 * Stack deployment order:
 *   BaseStack → DatabaseStack → KeycloakStack → AppStack
 *
 * Pattern A — Keycloak OIDC (default):
 *   User → App ALB (OIDC) → Backend ECS
 *                     ↓
 *              Keycloak ECS → Aurora Serverless V2
 *
 * Pattern B — SAML federation (optional, configured post-deploy):
 *   User → App ALB (OIDC) → Backend ECS
 *                     ↓
 *              Keycloak ECS (SAML SP) → External SAML IdP
 *                     ↓
 *              Aurora Serverless V2
 */
export class AlbKeycloakAuthStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: AlbKeycloakAuthStageProps) {
    super(scope, id, props);

    const stackEnv = {
      account: props.params.accountId,
      region: props.params.region ?? props.env?.region,
    };
    const isAlbOpen =
      !props.allowedIpsforAlb || props.allowedIpsforAlb.length === 0;
    const pc = pascalCase(props.project);

    // 1. VPC + Security Groups
    const baseStack = new BaseStack(this, `${pc}Base`, {
      project: props.project,
      environment: props.environment,
      env: stackEnv,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      vpcConfig: props.params.vpcConfig,
      allowedIpsforAlb: props.allowedIpsforAlb,
    });

    // 2. Aurora Serverless V2
    const dbStack = new DatabaseStack(this, `${pc}Database`, {
      project: props.project,
      environment: props.environment,
      env: stackEnv,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      vpc: baseStack.vpcConstruct.vpc,
      dbSg: baseStack.dbSg,
      auroraConfig: props.params.auroraConfig,
    });
    dbStack.addStackDependency(baseStack);

    // 3. Keycloak ECS Fargate + ALB
    const keycloakStack = new KeycloakStack(this, `${pc}Keycloak`, {
      project: props.project,
      environment: props.environment,
      env: stackEnv,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      vpc: baseStack.vpcConstruct.vpc,
      albSg: baseStack.keycloakAlbSg,
      keycloakEcsSg: baseStack.keycloakEcsSg,
      auroraCluster: dbStack.cluster,
      auroraSecret: dbStack.secret,
      keycloakConfig: props.params.keycloakConfig,
      isAlbOpen,
      domainName: props.params.keycloakDomainName,
      hostedZoneId: props.params.keycloakHostedZoneId,
    });
    keycloakStack.addStackDependency(dbStack);

    // 4. App ECS Fargate + ALB (with optional OIDC auth)
    const appStack = new AppStack(this, `${pc}App`, {
      project: props.project,
      environment: props.environment,
      env: stackEnv,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      vpc: baseStack.vpcConstruct.vpc,
      albSg: baseStack.appAlbSg,
      appEcsSg: baseStack.appEcsSg,
      oidcConfig: props.params.oidcConfig,
      keycloakBaseUrl: keycloakStack.keycloakBaseUrl,
      keycloakRealmName: props.params.keycloakConfig.realmName,
      isAlbOpen,
      domainName: props.params.appDomainName,
      hostedZoneId: props.params.appHostedZoneId,
    });
    appStack.addStackDependency(keycloakStack);
  }
}
