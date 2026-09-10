import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { OidcAlbConfig } from 'parameters/environments';

export interface AppStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly vpc: ec2.IVpc;
  readonly albSg: ec2.ISecurityGroup;
  readonly appEcsSg: ec2.ISecurityGroup;
  readonly oidcConfig: OidcAlbConfig;
  /** Keycloak base URL (e.g. https://keycloak.example.com) */
  readonly keycloakBaseUrl: string;
  readonly keycloakRealmName: string;
  readonly isAlbOpen: boolean;
  /** Custom domain for this ALB (required when oidcConfig.enabled=true). */
  readonly domainName?: string;
  readonly hostedZoneId?: string;
}

/**
 * Application ALB + ECS Fargate (nginx test app).
 *
 * When oidcConfig.enabled=true (and a domain/cert is provided),
 * the ALB listener uses Keycloak OIDC to authenticate every request.
 * Users are redirected to Keycloak login before reaching the backend.
 *
 * When oidcConfig.enabled=false, requests pass through without authentication
 * (useful for initial setup and connection testing).
 *
 * Setup steps:
 *  1. Deploy with oidcConfig.enabled=false
 *  2. Run scripts/keycloak-setup.sh to create realm + OIDC client
 *  3. Update the OIDC client secret in Secrets Manager
 *  4. Set oidcConfig.enabled=true, provide domain/cert, and redeploy
 */
export class AppStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  /** Placeholder secret for OIDC client credentials. Update after Keycloak setup. */
  public readonly oidcClientSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    if (props.oidcConfig.enabled && !props.domainName) {
      throw new Error(
        'OIDC authentication requires HTTPS. Provide appDomainName and appHostedZoneId.',
      );
    }

    // --- OIDC client secret placeholder ---
    // After running keycloak-setup.sh, update the clientSecret field in this secret.
    this.oidcClientSecret = new secretsmanager.Secret(this, 'OidcClientSecret', {
      secretName: `/${props.project}/${props.environment}/keycloak/oidc-client`,
      description:
        'Keycloak OIDC client credentials for ALB. Update clientSecret after keycloak-setup.sh.',
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({
          clientId: props.oidcConfig.clientId,
          clientSecret: 'REPLACE_AFTER_KEYCLOAK_SETUP',
        }),
      ),
    });

    // --- ALB ---
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      loadBalancerName: `${props.project}-${props.environment}-app`,
    });

    let certificate: acm.ICertificate | undefined;
    if (props.hostedZoneId && props.domainName) {
      certificate = new acm.Certificate(this, 'Certificate', {
        domainName: props.domainName,
        validation: acm.CertificateValidation.fromDns(),
      });
    }

    // --- ECS Cluster + Service ---
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: `${props.project}-${props.environment}-app`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${props.project}-${props.environment}/app`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
    });

    // nginx prints request headers in logs — useful for verifying OIDC auth headers
    taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:stable-alpine'),
      portMappings: [{ containerPort: 80 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'app', logGroup }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
    });

    const tg = new elbv2.ApplicationTargetGroup(this, 'Tg', {
      vpc: props.vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(5),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.appEcsSg],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
    });
    service.attachToApplicationTargetGroup(tg);

    // --- ALB Listener ---
    const keycloakOidcBase = `${props.keycloakBaseUrl}/realms/${props.keycloakRealmName}/protocol/openid-connect`;

    if (props.oidcConfig.enabled && certificate) {
      // HTTPS listener with Keycloak OIDC authentication
      this.alb.addListener('HttpRedirect', {
        port: 80,
        open: props.isAlbOpen,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });

      this.alb.addListener('Https', {
        port: 443,
        open: props.isAlbOpen,
        certificates: [certificate],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        defaultAction: elbv2.ListenerAction.authenticateOidc({
          issuer: `${props.keycloakBaseUrl}/realms/${props.keycloakRealmName}`,
          authorizationEndpoint: `${keycloakOidcBase}/auth`,
          tokenEndpoint: `${keycloakOidcBase}/token`,
          userInfoEndpoint: `${keycloakOidcBase}/userinfo`,
          clientId: props.oidcConfig.clientId,
          clientSecret: this.oidcClientSecret.secretValueFromJson('clientSecret'),
          next: elbv2.ListenerAction.forward([tg]),
          sessionTimeout: cdk.Duration.hours(8),
        }),
      });
    } else {
      // HTTP listener without authentication (testing / initial setup mode)
      this.alb.addListener('Http', {
        port: 80,
        open: props.isAlbOpen,
        defaultAction: elbv2.ListenerAction.forward([tg]),
      });
    }

    // --- Outputs ---
    new cdk.CfnOutput(this, 'AppAlbDns', {
      value: this.alb.loadBalancerDnsName,
      description: 'Application ALB DNS name',
    });
    new cdk.CfnOutput(this, 'OidcClientSecretArn', {
      value: this.oidcClientSecret.secretArn,
      description: 'OIDC client secret ARN — update clientSecret field after keycloak-setup.sh',
    });
    new cdk.CfnOutput(this, 'OidcEnabled', {
      value: String(props.oidcConfig.enabled && !!certificate),
      description: 'Whether ALB OIDC authentication is active',
    });
  }
}
