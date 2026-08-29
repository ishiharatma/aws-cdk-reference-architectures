import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'lib/types/transit-gateway-params';
import { TransitGatewayStack } from 'lib/stacks/transit-gateway-stack';

/**
 * Properties for {@link TransitGatewayStage}.
 */
export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
    readonly allowedIps: string[];
    readonly allowedIpv6s?: string[];
}

/**
 * Transit Gateway Stage
 *
 * Wraps the single {@link TransitGatewayStack} that provisions VPC A / B / C and the
 * Transit Gateway that meshes them together.
 */
export class TransitGatewayStage extends cdk.Stage {
    /**
     * Instantiates the single {@link TransitGatewayStack} for this stage.
     * @param scope parent construct
     * @param id stage id
     * @param props stage configuration
     */
    constructor(scope: Construct, id: string, props: StageProps) {
        super(scope, id, props);

        new TransitGatewayStack(this, pascalCase(`${props.project}TransitGateway`), {
            project: props.project,
            description: `${pascalCase(props.project)} multi-VPC Transit Gateway stack for ${props.environment}`,
            environment: props.environment,
            params: props.params,
            env: {
                account: props.params.accountId || props.env?.account,
                region: props.params.region || props.env?.region,
            },
            terminationProtection: props.terminationProtection,
            isAutoDeleteObject: props.isAutoDeleteObject,
            allowedIps: props.allowedIps,
            allowedIpv6s: props.allowedIpv6s,
        });
    }
}
