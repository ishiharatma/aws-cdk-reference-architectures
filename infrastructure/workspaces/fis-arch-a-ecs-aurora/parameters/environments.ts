import { VpcConfig } from '@common/types';
import { Environment, EnvironmentConfig } from "@common/parameters/environments";

/**
 * Environment parameters type for the FIS chaos scenarios workspace
 */
export interface EnvParams extends EnvironmentConfig {
    readonly vpcConfig: VpcConfig;
    /**
     * CloudFront managed prefix list ID (e.g. pl-58a04531 for ap-northeast-1).
     * Used to restrict ALB ingress to CloudFront VPC Origin traffic only.
     * If omitted, falls back to VPC CIDR block.
     */
    readonly cloudfrontManagedPrefixList?: string;
    /**
     * Email address subscribed to FIS experiment stop-condition alarms.
     * Optional — alarms are created regardless; no subscription if omitted.
     */
    readonly alarmEmail?: string;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
