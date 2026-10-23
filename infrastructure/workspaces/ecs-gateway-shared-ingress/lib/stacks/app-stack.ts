import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { AppParams, TestTrafficHeader } from 'parameters/environments';
import { GatewayConnectedService } from 'lib/constructs/gateway-connected-service';

/** Properties for {@link AppStack}. */
export interface AppStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: AppParams;
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly testTrafficHeader: TestTrafficHeader;
}

/**
 * Application team stack: services that opt in to the cluster's gateways with a gateway connector,
 * plus a probe function that calls internal gateway hostnames from inside the VPC.
 *
 * Nothing here references a gateway: which gateways a service connects to is decided by the cluster
 * associations (platform team) and the service's access type filter.
 */
export class AppStack extends cdk.Stack {
  readonly services: Record<string, ecs.IBaseService> = {};

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const namePrefix = `${props.project}-${props.environment}-ecsgw`;
    const removalPolicy = props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    for (const service of props.params.services) {
      const connected = new GatewayConnectedService(this, `${toPascal(service.name)}Service`, {
        cluster: props.cluster,
        serviceName: `${namePrefix}-${service.name}`,
        service,
        containerImage: props.params.containerImage,
        version: props.params.version,
        testTrafficHeader: props.testTrafficHeader,
        removalPolicy,
      });
      this.services[service.name] = connected.service;
      new cdk.CfnOutput(this, `${toPascal(service.name)}ServiceName`, { value: connected.service.serviceName });
    }

    const probe = new lambdaNodejs.NodejsFunction(this, 'ProbeFunction', {
      functionName: `${namePrefix}-probe`,
      description: 'Calls ECS gateway hostnames from inside the VPC (internal gateway verification)',
      entry: path.join(__dirname, '../../src/probe/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(60),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      logGroup: new logs.LogGroup(this, 'ProbeLogGroup', {
        logGroupName: `/aws/lambda/${namePrefix}-probe`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy,
      }),
    });
    new cdk.CfnOutput(this, 'ProbeFunctionName', { value: probe.functionName });
  }
}

function toPascal(name: string): string {
  return name.replace(/(^|-)(\w)/g, (_m, _sep, c: string) => c.toUpperCase());
}
