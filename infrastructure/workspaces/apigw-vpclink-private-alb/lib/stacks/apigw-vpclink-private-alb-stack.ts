import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface ApigwVpclinkPrivateAlbStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Publish a private ECS Fargate service through API Gateway only.
 *
 *   client --(API key, throttling)--> REST API --VPC link (v2)--> internal ALB --> Fargate tasks (private subnets)
 *
 * The ALB is `internal` and its security group accepts traffic from the VPC link's security group only,
 * so API Gateway is the single entry point and the usage plan, API key and throttling cannot be bypassed.
 */
export class ApigwVpclinkPrivateAlbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApigwVpclinkPrivateAlbStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-vpclink`;

    // ---------------------------------------------------------------------------------------------
    // Network: public subnets hold only the NAT gateway; everything else is private
    // ---------------------------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(params.vpcCidr),
      maxAzs: 2,
      natGateways: params.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: true,
      flowLogs: {
        all: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'VpcFlowLogGroup', {
              retention: logs.RetentionDays.ONE_WEEK,
              removalPolicy,
            }),
          ),
          trafficType: ec2.FlowLogTrafficType.REJECT,
        },
      },
    });

    // ---------------------------------------------------------------------------------------------
    // Backend: Fargate service behind an internal ALB
    // ---------------------------------------------------------------------------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `${namePrefix}-cluster`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    // Stock nginx; the entrypoint writes a small JSON document that names the task that served the request,
    // so the round trip through API Gateway, VPC link and ALB is visible without building an image.
    taskDefinition.addContainer('Web', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:stable'),
      portMappings: [{ containerPort: 80 }],
      entryPoint: ['/bin/sh', '-c'],
      command: [
        `printf '{"service":"backend","task":"%s"}\\n' "$(hostname)" > /usr/share/nginx/html/index.html && exec nginx -g 'daemon off;'`,
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'web',
        logGroup: new logs.LogGroup(this, 'WebLogGroup', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy }),
      }),
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Internal ALB: accepts HTTP from the API Gateway VPC link only',
      allowAllOutbound: false,
    });
    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      description: 'Fargate tasks: accept HTTP from the ALB only',
    });
    const vpcLinkSecurityGroup = new ec2.SecurityGroup(this, 'VpcLinkSecurityGroup', {
      vpc,
      description: 'API Gateway VPC link ENIs',
      allowAllOutbound: false,
    });

    vpcLinkSecurityGroup.addEgressRule(albSecurityGroup, ec2.Port.tcp(80), 'VPC link to ALB');
    albSecurityGroup.addIngressRule(vpcLinkSecurityGroup, ec2.Port.tcp(80), 'From API Gateway VPC link');
    albSecurityGroup.addEgressRule(serviceSecurityGroup, ec2.Port.tcp(80), 'ALB to tasks');
    serviceSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(80), 'From ALB');

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      serviceName: `${namePrefix}-web`,
      desiredCount: params.desiredCount,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false, // internal: no public IP, not reachable from the internet
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      dropInvalidHeaderFields: true,
    });
    const listener = alb.addListener('Http', { port: 80, protocol: elbv2.ApplicationProtocol.HTTP, open: false });
    listener.addTargets('Web', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: { path: '/', healthyHttpCodes: '200' },
      deregistrationDelay: cdk.Duration.seconds(10),
    });

    // ---------------------------------------------------------------------------------------------
    // VPC link v2: ENIs in the private subnets. Unlike the classic REST VPC link it targets an ALB
    // ALB directly, so no NLB is needed in between.
    // ---------------------------------------------------------------------------------------------
    const vpcLink = new apigatewayv2.CfnVpcLink(this, 'VpcLink', {
      name: `${namePrefix}-link`,
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
      securityGroupIds: [vpcLinkSecurityGroup.securityGroupId],
    });

    // ---------------------------------------------------------------------------------------------
    // REST API: API key + usage plan (throttling, quota) in front of the private backend
    // ---------------------------------------------------------------------------------------------
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });
    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${namePrefix}-api`,
      description: 'REST API that exposes a private ALB through a VPC link',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: {
        stageName: 'v1',
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        throttlingRateLimit: params.apiRateLimit,
        throttlingBurstLimit: params.apiBurstLimit,
      },
    });

    // The integration URI keeps the proxied path; `integrationTarget` carries the ALB ARN.
    const albIntegration = (pathSuffix: string, requestParameters?: Record<string, string>) =>
      new apigateway.HttpIntegration(`http://${alb.loadBalancerDnsName}/${pathSuffix}`, {
        httpMethod: 'ANY',
        proxy: true,
        options: { requestParameters, timeout: cdk.Duration.seconds(10) },
      });
    const privateIntegration = (method: apigateway.Method) => {
      const cfnMethod = method.node.defaultChild as apigateway.CfnMethod;
      cfnMethod.addPropertyOverride('Integration.ConnectionType', 'VPC_LINK');
      cfnMethod.addPropertyOverride('Integration.ConnectionId', vpcLink.attrVpcLinkId);
      cfnMethod.addPropertyOverride('Integration.IntegrationTarget', alb.loadBalancerArn);
    };

    const rootMethod = api.root.addMethod('ANY', albIntegration(''), { apiKeyRequired: true });
    const proxyMethod = api.root.addResource('{proxy+}').addMethod('ANY', albIntegration('{proxy}', {
      'integration.request.path.proxy': 'method.request.path.proxy',
    }), {
      apiKeyRequired: true,
      requestParameters: { 'method.request.path.proxy': true },
    });
    privateIntegration(rootMethod);
    privateIntegration(proxyMethod);

    const apiKey = api.addApiKey('ApiKey', { apiKeyName: `${namePrefix}-key` });
    const usagePlan = api.addUsagePlan('UsagePlan', {
      name: `${namePrefix}-plan`,
      throttle: { rateLimit: params.apiRateLimit, burstLimit: params.apiBurstLimit },
      quota: { limit: params.apiDailyQuota, period: apigateway.Period.DAY },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    // ---------------------------------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'ApiKeyId', { value: apiKey.keyId });
    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName, description: 'Internal ALB (resolves to private IPs only)' });
  }
}
