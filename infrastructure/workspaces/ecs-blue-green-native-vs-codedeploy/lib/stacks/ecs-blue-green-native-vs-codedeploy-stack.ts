import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface EcsBlueGreenNativeVsCodedeployStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
  /** Operator IPv4 addresses (bare IP or CIDR) allowed to reach both load balancers. */
  readonly allowedIps: string[];
  /** IPv6 counterpart; omit or pass an empty array if unavailable. */
  readonly allowedIpv6s?: string[];
}

/** Port of the production listener and of the test listener on both load balancers. */
const PROD_PORT = 80;
const TEST_PORT = 8080;

/**
 * The same application deployed blue/green two ways, side by side:
 *
 *   native     ECS service with deploymentStrategy BLUE_GREEN: ECS itself runs the green tasks, shifts the listeners,
 *              waits the bake time and rolls back; lifecycle hooks are Lambda functions
 *   CodeDeploy ECS service with the CODE_DEPLOY controller: a CodeDeploy application and deployment group do it,
 *              driven by an AppSpec; hooks are Lambda functions named in the AppSpec
 *
 * Each has its own internet-facing ALB (production listener on 80, test listener on 8080) restricted to the operator's IP.
 * New versions are made by registering a task definition revision: the check script does that and compares the two.
 */
export class EcsBlueGreenNativeVsCodedeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsBlueGreenNativeVsCodedeployStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-bg`;

    // ---------------------------------------------------------------------------------------------
    // Network: public subnets only; tasks get public IPs, so there is no NAT gateway to pay for
    // ---------------------------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(params.vpcCidr),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      restrictDefaultSecurityGroup: true,
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', { vpc, description: 'Load balancers: the operator only', allowAllOutbound: false });
    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', { vpc, description: 'Tasks: HTTP from the load balancers only' });
    for (const port of [PROD_PORT, TEST_PORT]) {
      for (const ip of props.allowedIps) {
        albSecurityGroup.addIngressRule(ec2.Peer.ipv4(ip.includes('/') ? ip : `${ip}/32`), ec2.Port.tcp(port), `operator ${ip}`);
      }
      for (const ip of props.allowedIpv6s ?? []) {
        albSecurityGroup.addIngressRule(ec2.Peer.ipv6(ip.includes('/') ? ip : `${ip}/128`), ec2.Port.tcp(port), `operator ${ip}`);
      }
    }
    albSecurityGroup.addEgressRule(serviceSecurityGroup, ec2.Port.tcp(80), 'ALB to tasks');
    serviceSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(80), 'From the ALBs');

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, clusterName: `${namePrefix}-cluster` });

    // ---------------------------------------------------------------------------------------------
    // The sample application: nginx that answers {"version","service","task"}. A new version is a task definition
    // revision with another VERSION; BREAK=true makes the container exit, which is how a bad release is simulated.
    // ---------------------------------------------------------------------------------------------
    const taskDefinition = (service: 'native' | 'codedeploy') => {
      const td = new ecs.FargateTaskDefinition(this, `${service}TaskDef`, {
        family: `${namePrefix}-${service}`,
        cpu: 256,
        memoryLimitMiB: 512,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      });
      td.addContainer('app', {
        image: ecs.ContainerImage.fromRegistry(params.containerImage),
        portMappings: [{ containerPort: 80 }],
        environment: { VERSION: 'v1', SERVICE: service, BREAK: 'false' },
        entryPoint: ['/bin/sh', '-c'],
        command: [
          `[ "$BREAK" = "true" ] && exit 1; printf '{"version":"%s","service":"%s","task":"%s"}\\n' "$VERSION" "$SERVICE" "$(hostname)" > /usr/share/nginx/html/index.html && exec nginx -g 'daemon off;'`,
        ],
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: service,
          logGroup: new logs.LogGroup(this, `${service}LogGroup`, { retention: logs.RetentionDays.ONE_WEEK, removalPolicy }),
        }),
      });
      return td;
    };

    const targetGroup = (id: string) => new elbv2.ApplicationTargetGroup(this, id, {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(5),
      healthCheck: { path: '/', interval: cdk.Duration.seconds(5), timeout: cdk.Duration.seconds(3), healthyThresholdCount: 2, unhealthyThresholdCount: 2 },
    });
    const loadBalancer = (id: string) => new elbv2.ApplicationLoadBalancer(this, id, {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      dropInvalidHeaderFields: true,
    });
    const serviceProps = {
      cluster,
      desiredCount: params.desiredCount,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
    };

    // ---------------------------------------------------------------------------------------------
    // Lifecycle hook: answers after a delay (a window to look at the test listener) with the verdict held in SSM
    // ---------------------------------------------------------------------------------------------
    // One verdict per flavor, so the two can be driven at the same time without affecting each other.
    const hookVerdict = (flavor: 'native' | 'codedeploy') => new ssm.StringParameter(this, `${flavor}HookVerdict`, {
      parameterName: `/${project}/${environment}/bluegreen/hook-verdict-${flavor}`,
      stringValue: 'pass',
      description: `pass or fail: what the sample lifecycle hook answers for ${flavor} deployments`,
    });
    const nativeVerdict = hookVerdict('native');
    const codeDeployVerdict = hookVerdict('codedeploy');
    const hookFunction = new lambdaNodejs.NodejsFunction(this, 'HookFunction', {
      functionName: `${namePrefix}-hook`,
      entry: path.join(__dirname, '../../src/hook/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(2),
      environment: {
        VERDICT_PARAMETER_NATIVE: nativeVerdict.parameterName,
        VERDICT_PARAMETER_CODEDEPLOY: codeDeployVerdict.parameterName,
        HOOK_DELAY_SECONDS: String(params.hookDelaySeconds),
      },
      logGroup: new logs.LogGroup(this, 'HookLogGroup', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy }),
    });
    nativeVerdict.grantRead(hookFunction);
    codeDeployVerdict.grantRead(hookFunction);
    // CodeDeploy hooks report their result through the API instead of the return value.
    hookFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ['codedeploy:PutLifecycleEventHookExecutionStatus'], resources: ['*'] }));

    // ---------------------------------------------------------------------------------------------
    // 1. Native ECS blue/green
    // ---------------------------------------------------------------------------------------------
    const nativeAlb = loadBalancer('NativeAlb');
    const nativeProdListener = nativeAlb.addListener('NativeProd', { port: PROD_PORT, open: false, defaultAction: elbv2.ListenerAction.fixedResponse(404) });
    const nativeTestListener = nativeAlb.addListener('NativeTest', { port: TEST_PORT, open: false, defaultAction: elbv2.ListenerAction.fixedResponse(404) });
    const nativeBlue = targetGroup('NativeBlue');
    const nativeGreen = targetGroup('NativeGreen');
    // Native blue/green swaps the target groups of listener RULES, so the listeners route through rules.
    const nativeProdRule = new elbv2.ApplicationListenerRule(this, 'NativeProdRule', {
      listener: nativeProdListener,
      priority: 1,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
      action: elbv2.ListenerAction.forward([nativeBlue]),
    });
    const nativeTestRule = new elbv2.ApplicationListenerRule(this, 'NativeTestRule', {
      listener: nativeTestListener,
      priority: 1,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
      action: elbv2.ListenerAction.forward([nativeGreen]),
    });
    const nativeService = new ecs.FargateService(this, 'NativeService', {
      ...serviceProps,
      serviceName: `${namePrefix}-native`,
      taskDefinition: taskDefinition('native'),
      deploymentStrategy: ecs.DeploymentStrategy.BLUE_GREEN,
      bakeTime: cdk.Duration.minutes(params.nativeBakeMinutes),
    });
    nativeService.addLifecycleHook(new ecs.DeploymentLifecycleLambdaTarget(hookFunction, 'NativePostTestTrafficHook', {
      lifecycleStages: [ecs.DeploymentLifecycleStage.POST_TEST_TRAFFIC_SHIFT],
    }));
    nativeService.loadBalancerTarget({
      containerName: 'app',
      containerPort: 80,
      protocol: ecs.Protocol.TCP,
      alternateTarget: new ecs.AlternateTarget('NativeAlternateTarget', {
        alternateTargetGroup: nativeGreen,
        productionListener: ecs.ListenerRuleConfiguration.applicationListenerRule(nativeProdRule),
        testListener: ecs.ListenerRuleConfiguration.applicationListenerRule(nativeTestRule),
      }),
    }).attachToApplicationTargetGroup(nativeBlue);

    // ---------------------------------------------------------------------------------------------
    // 2. CodeDeploy blue/green
    // ---------------------------------------------------------------------------------------------
    const cdAlb = loadBalancer('CodeDeployAlb');
    const cdBlue = targetGroup('CodeDeployBlue');
    const cdGreen = targetGroup('CodeDeployGreen');
    const cdProdListener = cdAlb.addListener('CodeDeployProd', { port: PROD_PORT, open: false, defaultAction: elbv2.ListenerAction.forward([cdBlue]) });
    const cdTestListener = cdAlb.addListener('CodeDeployTest', { port: TEST_PORT, open: false, defaultAction: elbv2.ListenerAction.forward([cdGreen]) });
    const cdService = new ecs.FargateService(this, 'CodeDeployService', {
      ...serviceProps,
      serviceName: `${namePrefix}-codedeploy`,
      taskDefinition: taskDefinition('codedeploy'),
      deploymentController: { type: ecs.DeploymentControllerType.CODE_DEPLOY },
    });
    cdBlue.addTarget(cdService.loadBalancerTarget({ containerName: 'app', containerPort: 80 }));

    const application = new codedeploy.EcsApplication(this, 'CodeDeployApplication', { applicationName: `${namePrefix}-app` });
    const errorAlarm = new cloudwatch.Alarm(this, 'CodeDeployErrorAlarm', {
      alarmName: `${namePrefix}-codedeploy-5xx`,
      metric: cdBlue.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: cdk.Duration.minutes(1), statistic: 'Sum' }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const deploymentGroup = new codedeploy.EcsDeploymentGroup(this, 'CodeDeployGroup', {
      application,
      deploymentGroupName: `${namePrefix}-group`,
      service: cdService,
      blueGreenDeploymentConfig: {
        blueTargetGroup: cdBlue,
        greenTargetGroup: cdGreen,
        listener: cdProdListener,
        testListener: cdTestListener,
        terminationWaitTime: cdk.Duration.minutes(params.codeDeployTerminationWaitMinutes),
      },
      deploymentConfig: codedeploy.EcsDeploymentConfig.ALL_AT_ONCE,
      alarms: [errorAlarm],
      autoRollback: { failedDeployment: true, stoppedDeployment: false, deploymentInAlarm: true },
    });
    hookFunction.grantInvoke(deploymentGroup.role);

    // ---------------------------------------------------------------------------------------------
    // Outputs (used by test-deployments.sh)
    // ---------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'NativeServiceName', { value: nativeService.serviceName });
    new cdk.CfnOutput(this, 'NativeUrl', { value: `http://${nativeAlb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'NativeTestUrl', { value: `http://${nativeAlb.loadBalancerDnsName}:${TEST_PORT}` });
    new cdk.CfnOutput(this, 'CodeDeployServiceName', { value: cdService.serviceName });
    new cdk.CfnOutput(this, 'CodeDeployUrl', { value: `http://${cdAlb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'CodeDeployTestUrl', { value: `http://${cdAlb.loadBalancerDnsName}:${TEST_PORT}` });
    new cdk.CfnOutput(this, 'CodeDeployApplicationName', { value: application.applicationName });
    new cdk.CfnOutput(this, 'CodeDeployGroupName', { value: deploymentGroup.deploymentGroupName });
    new cdk.CfnOutput(this, 'NativeTaskFamily', { value: `${namePrefix}-native` });
    new cdk.CfnOutput(this, 'CodeDeployTaskFamily', { value: `${namePrefix}-codedeploy` });
    new cdk.CfnOutput(this, 'HookFunctionName', { value: hookFunction.functionName });
    new cdk.CfnOutput(this, 'NativeHookVerdictParameter', { value: nativeVerdict.parameterName });
    new cdk.CfnOutput(this, 'CodeDeployHookVerdictParameter', { value: codeDeployVerdict.parameterName });
  }
}
