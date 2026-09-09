import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { VpcConfig } from '@common/types';
import { VpcConstruct } from '@common/constructs/vpc/vpc';

export interface BaseStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly vpcConfig: VpcConfig;
  /** Allowed CIDR blocks for ALB ingress. When empty, allows all IPv4. */
  readonly allowedIpsforAlb?: string[];
}

/**
 * Base stack: VPC and Security Groups for all components.
 *
 * Security group topology:
 *   Internet → keycloakAlbSg (80/443)
 *   Internet → appAlbSg (80/443)
 *   keycloakAlbSg → keycloakEcsSg (8080)
 *   appAlbSg → appEcsSg (80)
 *   keycloakEcsSg → dbSg (5432)
 */
export class BaseStack extends cdk.Stack {
  public readonly vpcConstruct: VpcConstruct;
  /** Security group for the Keycloak ALB */
  public readonly keycloakAlbSg: ec2.SecurityGroup;
  /** Security group for the App ALB */
  public readonly appAlbSg: ec2.SecurityGroup;
  /** Security group for Keycloak ECS tasks */
  public readonly keycloakEcsSg: ec2.SecurityGroup;
  /** Security group for App ECS tasks */
  public readonly appEcsSg: ec2.SecurityGroup;
  /** Security group for Aurora PostgreSQL */
  public readonly dbSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, props);

    this.vpcConstruct = new VpcConstruct(this, 'Vpc', {
      project: props.project,
      environment: props.environment,
      config: props.vpcConfig,
      prefix: [props.project, props.environment].join('/'),
    });
    const vpc = this.vpcConstruct.vpc;

    const addAlbIngress = (sg: ec2.SecurityGroup, label: string) => {
      if (props.allowedIpsforAlb && props.allowedIpsforAlb.length > 0) {
        for (const ip of props.allowedIpsforAlb) {
          sg.addIngressRule(ec2.Peer.ipv4(ip), ec2.Port.tcp(80), `HTTP ${label} from ${ip}`);
          sg.addIngressRule(ec2.Peer.ipv4(ip), ec2.Port.tcp(443), `HTTPS ${label} from ${ip}`);
        }
      } else {
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), `HTTP ${label} from anywhere`);
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), `HTTPS ${label} from anywhere`);
      }
    };

    // Keycloak ALB SG
    this.keycloakAlbSg = new ec2.SecurityGroup(this, 'KeycloakAlbSg', {
      vpc,
      securityGroupName: `${props.project}-${props.environment}-keycloak-alb-sg`,
      description: 'Keycloak ALB — inbound HTTP/HTTPS',
      allowAllOutbound: true,
    });
    addAlbIngress(this.keycloakAlbSg, 'keycloak-alb');

    // App ALB SG
    this.appAlbSg = new ec2.SecurityGroup(this, 'AppAlbSg', {
      vpc,
      securityGroupName: `${props.project}-${props.environment}-app-alb-sg`,
      description: 'App ALB — inbound HTTP/HTTPS',
      allowAllOutbound: true,
    });
    addAlbIngress(this.appAlbSg, 'app-alb');

    // Keycloak ECS SG — receives traffic from Keycloak ALB only
    this.keycloakEcsSg = new ec2.SecurityGroup(this, 'KeycloakEcsSg', {
      vpc,
      securityGroupName: `${props.project}-${props.environment}-keycloak-ecs-sg`,
      description: 'Keycloak ECS tasks',
      allowAllOutbound: true,
    });
    this.keycloakEcsSg.addIngressRule(
      ec2.Peer.securityGroupId(this.keycloakAlbSg.securityGroupId),
      ec2.Port.tcp(8080),
      'Keycloak HTTP from ALB',
    );

    // App ECS SG — receives traffic from App ALB only
    this.appEcsSg = new ec2.SecurityGroup(this, 'AppEcsSg', {
      vpc,
      securityGroupName: `${props.project}-${props.environment}-app-ecs-sg`,
      description: 'App ECS tasks',
      allowAllOutbound: true,
    });
    this.appEcsSg.addIngressRule(
      ec2.Peer.securityGroupId(this.appAlbSg.securityGroupId),
      ec2.Port.tcp(80),
      'App HTTP from ALB',
    );

    // Aurora SG — receives traffic from Keycloak ECS only
    this.dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      securityGroupName: `${props.project}-${props.environment}-db-sg`,
      description: 'Aurora PostgreSQL — inbound from Keycloak ECS',
      allowAllOutbound: false,
    });
    this.dbSg.addIngressRule(
      ec2.Peer.securityGroupId(this.keycloakEcsSg.securityGroupId),
      ec2.Port.tcp(5432),
      'PostgreSQL from Keycloak ECS',
    );
  }
}
