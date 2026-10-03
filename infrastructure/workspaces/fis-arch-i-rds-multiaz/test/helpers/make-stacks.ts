import * as cdk from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { params } from 'parameters/environments';
import '../parameters';

import { BaseStack } from 'lib/stacks/base-stack';
import { ProbeStack } from 'lib/stacks/probe-stack';
import { FisStack } from 'lib/stacks/fis-stack';

export const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
export const projectName = 'fis-chaos-i';
export const envName: Environment = Environment.TEST;

export function makeStacks(appId = 'Test') {
    const envParams = params[envName]!;
    const app = new cdk.App();

    const baseStack = new BaseStack(app, `${appId}Base`, {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
        vpcConfig: envParams.vpcConfig,
        dbInstanceClass: envParams.dbInstanceClass,
        clusterInstanceClass: envParams.clusterInstanceClass,
    });
    const probeStack = new ProbeStack(app, `${appId}Probe`, {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        vpc: baseStack.vpc,
        dbSecurityGroup: baseStack.dbSecurityGroup,
        dbSecret: baseStack.dbSecret,
        instanceEndpoint: baseStack.multiAzInstance.dbInstanceEndpointAddress,
        clusterEndpoint: baseStack.multiAzClusterEndpoint,
    });
    const fisStack = new FisStack(app, `${appId}Fis`, {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        multiAzInstance: baseStack.multiAzInstance,
        multiAzClusterArn: baseStack.multiAzClusterArn,
        instanceAlarm: probeStack.instanceAlarm,
        clusterAlarm: probeStack.clusterAlarm,
    });
    return { app, baseStack, probeStack, fisStack };
}
