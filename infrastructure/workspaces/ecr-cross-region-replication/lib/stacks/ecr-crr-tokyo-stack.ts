import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EcrConstruct } from '@common/constructs/ecr';
import { EnvParams } from 'parameters/environments';

/** Props for {@link EcrCrrTokyoStack}. */
export interface EcrCrrTokyoStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly params: EnvParams;
}

/**
 * Source ECR repository (Tokyo / ap-northeast-1) plus the registry-wide
 * replication configuration that pushes images to the pre-created Osaka
 * repository.
 *
 * `AWS::ECR::ReplicationConfiguration` is a single, registry-wide resource
 * per account/region — only one should ever be declared per source region.
 */
export class EcrCrrTokyoStack extends cdk.Stack {
    public readonly repository: EcrConstruct;
    public readonly replicationConfiguration: ecr.CfnReplicationConfiguration;

    constructor(scope: Construct, id: string, props: EcrCrrTokyoStackProps) {
        super(scope, id, props);

        const { ecrCrr } = props.params;
        const destinationRegion = ecrCrr.destinationRegion ?? 'ap-northeast-3';

        const sourceRepositoryNameSuffix = ecrCrr.sourceEcrConfig.createConfig?.repositoryNameSuffix;
        const destinationRepositoryNameSuffix = (ecrCrr.destinationEcrConfig ?? ecrCrr.sourceEcrConfig).createConfig
            ?.repositoryNameSuffix;

        // ECR replication matches repositories by name. If the source and destination
        // suffixes diverge, replicated images land in an auto-created destination
        // repository instead of the one we pre-created with its own lifecycle policy.
        if (!sourceRepositoryNameSuffix || sourceRepositoryNameSuffix !== destinationRepositoryNameSuffix) {
            throw new Error(
                'sourceEcrConfig.createConfig.repositoryNameSuffix and destinationEcrConfig.createConfig.repositoryNameSuffix ' +
                    'must be set and identical, so replicated images land in the pre-created Osaka repository.',
            );
        }

        this.repository = new EcrConstruct(this, 'EcrSource', {
            project: props.project,
            environment: props.environment,
            ecrConfig: ecrCrr.sourceEcrConfig,
        });

        const repositoryName = `${props.project}-${props.environment}-${sourceRepositoryNameSuffix}`;

        this.replicationConfiguration = new ecr.CfnReplicationConfiguration(this, 'ReplicationConfiguration', {
            replicationConfiguration: {
                rules: [
                    {
                        destinations: [
                            {
                                region: destinationRegion,
                                registryId: this.account,
                            },
                        ],
                        repositoryFilters: [
                            {
                                filter: repositoryName,
                                filterType: 'PREFIX_MATCH',
                            },
                        ],
                    },
                ],
            },
        });
        this.replicationConfiguration.node.addDependency(this.repository);
    }
}
