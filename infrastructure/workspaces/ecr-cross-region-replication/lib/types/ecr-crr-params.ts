import { EcrConfig } from '@common/types';

/**
 * Parameters for the ECR Cross-Region Replication (CRR) pattern.
 *
 * Both `sourceEcrConfig` and `destinationEcrConfig` must resolve to the same
 * `createConfig.repositoryNameSuffix` — ECR replication matches repositories
 * by name, so the source (Tokyo) and destination (Osaka) repositories must
 * share the identical physical name for replicated images to land in the
 * pre-created destination repository instead of an auto-created one.
 */
export interface EcrCrrParams {
    /**
     * Create/lifecycle configuration for the source repository in the
     * primary region (Tokyo / ap-northeast-1).
     */
    readonly sourceEcrConfig: EcrConfig;

    /**
     * Create/lifecycle configuration for the destination repository in the
     * replica region (Osaka / ap-northeast-3).
     *
     * Pre-creating this repository — instead of letting ECR replication
     * auto-create it on first image push — is what lets it carry its own
     * lifecycle policy. A repository auto-created by replication has no
     * lifecycle policy at all, which silently defeats image cleanup in the
     * replica region.
     *
     * @default same as sourceEcrConfig
     */
    readonly destinationEcrConfig?: EcrConfig;

    /**
     * Destination region for the replication rule.
     * @default 'ap-northeast-3'
     */
    readonly destinationRegion?: string;
}
