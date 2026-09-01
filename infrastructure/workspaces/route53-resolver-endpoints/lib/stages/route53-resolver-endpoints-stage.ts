import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'lib/types/route53-resolver-endpoints-params';
import { Route53ResolverEndpointsStack } from 'lib/stacks/route53-resolver-endpoints-stack';

/**
 * Properties for {@link Route53ResolverEndpointsStage}.
 */
export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

/**
 * Route 53 Resolver Endpoints Stage
 *
 * Wraps the single {@link Route53ResolverEndpointsStack}.
 */
export class Route53ResolverEndpointsStage extends cdk.Stage {
    /**
     * Instantiates the single {@link Route53ResolverEndpointsStack} for this stage.
     * @param scope parent construct
     * @param id stage id
     * @param props stage configuration
     */
    constructor(scope: Construct, id: string, props: StageProps) {
        super(scope, id, props);

        new Route53ResolverEndpointsStack(this, pascalCase(`${props.project}Route53ResolverEndpoints`), {
            project: props.project,
            description: `${pascalCase(props.project)} Route53 Resolver Endpoints stack for ${props.environment}`,
            environment: props.environment,
            params: props.params,
            env: {
                account: props.params.accountId || props.env?.account,
                region: props.params.region || props.env?.region,
            },
            terminationProtection: props.terminationProtection,
            isAutoDeleteObject: props.isAutoDeleteObject,
        });
    }
}
