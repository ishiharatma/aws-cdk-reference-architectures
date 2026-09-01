import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'lib/types/route53-phz-delegation-params';
import { Route53PhzDelegationStack } from 'lib/stacks/route53-phz-delegation-stack';

/**
 * Properties for {@link Route53PhzDelegationStage}.
 */
export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

/**
 * Route 53 Private Hosted Zone Delegation Stage
 *
 * Wraps the single {@link Route53PhzDelegationStack}.
 */
export class Route53PhzDelegationStage extends cdk.Stage {
    /**
     * Instantiates the single {@link Route53PhzDelegationStack} for this stage.
     * @param scope parent construct
     * @param id stage id
     * @param props stage configuration
     */
    constructor(scope: Construct, id: string, props: StageProps) {
        super(scope, id, props);

        new Route53PhzDelegationStack(this, pascalCase(`${props.project}Route53PhzDelegation`), {
            project: props.project,
            description: `${pascalCase(props.project)} Route53 private hosted zone delegation stack for ${props.environment}`,
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
