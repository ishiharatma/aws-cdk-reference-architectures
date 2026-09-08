import { VpcConfig } from '@common/types';
import { Environment, EnvironmentConfig } from '@common/parameters/environments';

export interface EnvParams extends EnvironmentConfig {
    readonly vpcConfig: VpcConfig;
    /**
     * CloudFront managed prefix list ID (e.g. pl-58a04531 for ap-northeast-1).
     * Used to restrict ALB ingress to CloudFront VPC Origin traffic only.
     * Falls back to VPC CIDR when omitted.
     */
    readonly cloudfrontManagedPrefixList?: string;
    /**
     * Email address subscribed to FIS experiment stop-condition alarms.
     * Optional — alarms are created regardless; no subscription if omitted.
     */
    readonly alarmEmail?: string;
}

export const params: Partial<Record<Environment, EnvParams>> = {};
