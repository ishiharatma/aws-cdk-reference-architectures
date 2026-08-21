import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EcrConstruct } from '@common/constructs/ecr';
import { EnvParams } from 'parameters/environments';

/** Props for {@link EcrCrrOsakaStack}. */
export interface EcrCrrOsakaStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly params: EnvParams;
}

/**
 * Destination ECR repository (Osaka / ap-northeast-3).
 *
 * Pre-creating this repository — instead of letting ECR replication
 * auto-create it on first image push — is what lets it carry its own
 * lifecycle policy independently of the source repository in Tokyo.
 */
export class EcrCrrOsakaStack extends cdk.Stack {
    public readonly repository: EcrConstruct;

    constructor(scope: Construct, id: string, props: EcrCrrOsakaStackProps) {
        super(scope, id, props);

        const destinationEcrConfig = props.params.ecrCrr.destinationEcrConfig ?? props.params.ecrCrr.sourceEcrConfig;

        this.repository = new EcrConstruct(this, 'EcrDestination', {
            project: props.project,
            environment: props.environment,
            ecrConfig: destinationEcrConfig,
        });
    }
}
