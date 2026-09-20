import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { KeycloakEcsConfig } from 'parameters/environments';

export interface KeycloakStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly vpc: ec2.IVpc;
  readonly albSg: ec2.ISecurityGroup;
  readonly keycloakEcsSg: ec2.ISecurityGroup;
  readonly auroraCluster: rds.DatabaseCluster;
  readonly auroraSecret: rds.DatabaseSecret;
  /** Database name inside the Aurora cluster (the L2 construct doesn't expose this back as a property). */
  readonly databaseName: string;
  readonly keycloakConfig: KeycloakEcsConfig;
  /** Whether to allow all IPv4 traffic to the ALB (when allowedIps is empty). */
  readonly isAlbOpen: boolean;
  /** Optional custom domain for Keycloak (requires Route53 Hosted Zone). */
  readonly domainName?: string;
  readonly hostedZoneId?: string;
}

/**
 * Deploys Keycloak on ECS Fargate behind an internet-facing ALB.
 *
 * Keycloak uses Aurora Serverless V2 (PostgreSQL) as its database.
 * Admin credentials are auto-generated in Secrets Manager.
 *
 * After deployment, run scripts/keycloak-setup.sh to:
 *   1. Create the realm
 *   2. Create the OIDC client for ALB authentication
 *   3. (Optional) Configure SAML IdP via scripts/saml-setup.sh
 */
export class KeycloakStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  /** Base URL for Keycloak (http or https depending on cert availability). */
  public readonly keycloakBaseUrl: string;
  /** Keycloak admin credentials secret (auto-generated). */
  public readonly adminSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: KeycloakStackProps) {
    super(scope, id, props);

    // --- Admin credentials (auto-generated) ---
    this.adminSecret = new secretsmanager.Secret(this, 'AdminSecret', {
      secretName: `/${props.project}/${props.environment}/keycloak/admin`,
      description: 'Keycloak admin credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\',
        passwordLength: 24,
      },
    });

    // --- ALB ---
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      loadBalancerName: `${props.project}-${props.environment}-kc`,
    });

    let certificate: acm.ICertificate | undefined;
    if (props.hostedZoneId && props.domainName) {
      certificate = new acm.Certificate(this, 'Certificate', {
        domainName: props.domainName,
        validation: acm.CertificateValidation.fromDns(),
      });
    }

    // HTTP listener: redirects to HTTPS if cert present, else forwards
    const httpDefaultAction = certificate
      ? elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true })
      : elbv2.ListenerAction.fixedResponse(404, { contentType: 'text/plain', messageBody: 'Not Found' });

    const httpListener = this.alb.addListener('Http', {
      port: 80,
      open: props.isAlbOpen,
      defaultAction: httpDefaultAction,
    });

    const activeListener: elbv2.IApplicationListener = certificate
      ? this.alb.addListener('Https', {
          port: 443,
          open: props.isAlbOpen,
          certificates: [certificate],
          sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
          defaultAction: elbv2.ListenerAction.fixedResponse(404, {
            contentType: 'text/plain',
            messageBody: 'Not Found',
          }),
        })
      : httpListener;

    const keycloakDomain = props.domainName ?? this.alb.loadBalancerDnsName;
    const protocol = certificate ? 'https' : 'http';
    this.keycloakBaseUrl = `${protocol}://${keycloakDomain}`;

    // --- ECS Cluster ---
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: `${props.project}-${props.environment}-keycloak`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${props.project}-${props.environment}/keycloak`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Execution role: pull image + read secrets
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    props.auroraSecret.grantRead(executionRole);
    this.adminSecret.grantRead(executionRole);

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: props.keycloakConfig.cpu,
      memoryLimitMiB: props.keycloakConfig.memoryLimitMiB,
      executionRole,
    });

    taskDef.addContainer('keycloak', {
      image: ecs.ContainerImage.fromRegistry(
        `quay.io/keycloak/keycloak:${props.keycloakConfig.keycloakVersion}`,
      ),
      // 'start' builds Keycloak on first run (~60s). Use a pre-built image for production.
      command: ['start'],
      environment: {
        KC_DB: 'postgres',
        KC_DB_URL: `jdbc:postgresql://${props.auroraCluster.clusterEndpoint.hostname}:5432/${props.databaseName}`,
        KC_HOSTNAME_STRICT: 'false',
        KC_PROXY_HEADERS: 'xforwarded',
        KC_HTTP_ENABLED: 'true',
        KC_HEALTH_ENABLED: 'true',
        KC_METRICS_ENABLED: 'true',
        KC_LOG_LEVEL: 'info',
      },
      secrets: {
        KC_DB_USERNAME: ecs.Secret.fromSecretsManager(props.auroraSecret, 'username'),
        KC_DB_PASSWORD: ecs.Secret.fromSecretsManager(props.auroraSecret, 'password'),
        KEYCLOAK_ADMIN: ecs.Secret.fromSecretsManager(this.adminSecret, 'username'),
        KEYCLOAK_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(this.adminSecret, 'password'),
      },
      portMappings: [{ containerPort: 8080 }, { containerPort: 9000 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'keycloak', logGroup }),
      healthCheck: {
        // Keycloak >= 26 serves /health/ready on the separate "management"
        // interface (port 9000 by default), not the main HTTP port (8080) --
        // verified via `aws ecs execute-command` (port 8080 404s, 9000
        // returns {"status":"UP",...}). The quay.io/keycloak/keycloak image
        // has no curl/wget either, so this uses bash's /dev/tcp instead.
        command: [
          'CMD-SHELL',
          'exec 3<>/dev/tcp/localhost/9000 && ' +
            'printf "GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n" >&3 && ' +
            'timeout 5 cat <&3 | grep -q "200 OK"',
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 5,
        startPeriod: cdk.Duration.seconds(180),
      },
    });

    // --- Target Group ---
    const tg = new elbv2.ApplicationTargetGroup(this, 'Tg', {
      vpc: props.vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        // Same management-port caveat as the container healthCheck above:
        // /health/ready lives on port 9000, not the target group's traffic
        // port (8080).
        port: '9000',
        path: '/health/ready',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyHttpCodes: '200',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
      deregistrationDelay: cdk.Duration.seconds(60),
    });

    activeListener.addTargetGroups('Keycloak', { targetGroups: [tg] });

    // --- ECS Service ---
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: props.keycloakConfig.desiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.keycloakEcsSg],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
    });
    service.attachToApplicationTargetGroup(tg);

    // --- Outputs ---
    new cdk.CfnOutput(this, 'KeycloakAlbDns', {
      value: this.alb.loadBalancerDnsName,
      description: 'Keycloak ALB DNS name',
    });
    new cdk.CfnOutput(this, 'KeycloakBaseUrl', {
      value: this.keycloakBaseUrl,
      description: 'Keycloak base URL',
    });
    new cdk.CfnOutput(this, 'KeycloakAdminConsole', {
      value: `${this.keycloakBaseUrl}/admin`,
      description: 'Keycloak admin console URL',
    });
    new cdk.CfnOutput(this, 'AdminSecretArn', {
      value: this.adminSecret.secretArn,
      description: 'Keycloak admin credentials secret ARN',
    });
    new cdk.CfnOutput(this, 'RealmOidcDiscovery', {
      value: `${this.keycloakBaseUrl}/realms/${props.keycloakConfig.realmName}/.well-known/openid-configuration`,
      description: 'Keycloak OIDC discovery URL for the realm',
    });
  }
}
