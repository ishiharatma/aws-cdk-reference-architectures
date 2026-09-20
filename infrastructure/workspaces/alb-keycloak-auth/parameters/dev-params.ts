import * as cdk from 'aws-cdk-lib';
import { params, EnvParams } from 'parameters/environments';
import { NatType } from '@common/types';
import { Environment } from '@common/parameters/environments';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Development environment parameters.
 *
 * Deployment flow:
 *  1. cdk deploy (this deploys all stacks)
 *  2. Run scripts/keycloak-setup.sh to create realm + OIDC client
 *  3. To enable SAML: run scripts/saml-setup.sh
 *  4. To enable ALB OIDC auth: set oidcConfig.enabled=true,
 *     provide appDomainName/appHostedZoneId, then redeploy
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  stackNamePrefix: 'alb-keycloak-auth',
  tags: {},
  vpcConfig: {
    createConfig: {
      vpcName: 'KeycloakVpc',
      cidr: '10.0.0.0/16',
      maxAzs: 2,
      natCount: 1,
      natType: NatType.INSTANCE,
      // The shared VpcConstruct's NAT Instance default (T4G.NANO, 0.5GiB RAM)
      // gets OOM-killed running `yum install iptables-services` on the Amazon
      // Linux 2023 AMI it uses -- the instance passes EC2 health checks but
      // NAT silently never works (verified via `aws ec2 get-console-output`:
      // "Out of memory: Killed process ... yum"). T4G.MICRO (1GiB) has enough
      // headroom for that install to succeed.
      natInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      subnets: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
      natSchedule: {
        startCronSchedule: 'cron(0 18 * * ? *)',
        stopCronSchedule: 'cron(0 21 * * ? *)',
        timeZone: cdk.TimeZone.ASIA_TOKYO,
      },
    },
  },
  auroraConfig: {
    databaseName: 'keycloakdb',
    masterUsername: 'keycloak',
    serverlessV2MinCapacity: 0.5,
    serverlessV2MaxCapacity: 4,
  },
  keycloakConfig: {
    keycloakVersion: '26.1',
    realmName: 'myrealm',
    cpu: 1024,
    memoryLimitMiB: 2048,
    desiredCount: 1,
  },
  oidcConfig: {
    // Set to true after running keycloak-setup.sh and providing domain/cert
    enabled: false,
    clientId: 'alb-client',
  },
  // Uncomment to enable SAML federation (run scripts/saml-setup.sh after deploy)
  // samlConfig: {
  //   enabled: true,
  //   idpAlias: 'saml-idp',
  //   idpDisplayName: 'Corporate SAML IdP',
  //   idpMetadataUrl: 'https://your-saml-idp.example.com/saml/metadata',
  // },
  //
  // Uncomment to use custom domains (required for OIDC auth)
  // keycloakDomainName: 'keycloak.example.com',
  // keycloakHostedZoneId: 'Z1234567890ABC',
  // appDomainName: 'app.example.com',
  // appHostedZoneId: 'Z1234567890ABC',
};

params[Environment.DEVELOPMENT] = devParams;
