import { VpcConfig } from '@common/types';
import { Environment, EnvironmentConfig  } from "@common/parameters/environments";

/**
 * Incident-response escape hatch for outages like the 2026-07-16 AWS CloudFront VPC Origins
 * incident, where VPC Origin connectivity itself was degraded (AWS's own guidance at the time
 * was to temporarily switch away from VPC Origin connectivity). When enabled, the ALB becomes
 * internet-facing and CloudFront's `/alb/*` behavior is switched to reach it as a plain public
 * HTTP origin instead of through VPC Origin connectivity. Traffic still only ever flows through
 * CloudFront — the ALB's security group continues to admit only CloudFront's managed prefix
 * list, never the raw internet. The VPC Origin registration itself is left in place (as the
 * origin group's fallback) so reverting is just flipping `enabled` back to `false`.
 */
export interface PublicAlbFailoverConfig {
    readonly enabled: boolean;
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
    readonly vpcConfig: VpcConfig;
    /**
     * CloudFront managed prefix list ID (e.g. com.amazonaws.<region>.cloudfront.origin-facing)
     * to allow ALB access from. Optional — if omitted, the stack falls back to allowing the
     * VPC's own CIDR block instead.
     */
    readonly cloudfrontManagedPrefixList?: string;
    /**
     * Incident-response escape hatch — see `PublicAlbFailoverConfig`. Defaults to disabled
     * (internal-only ALB) when omitted.
     */
    readonly publicAlbFailover?: PublicAlbFailoverConfig;
    /**
     * Email address subscribed to the CloudFront 5xx error rate alarm (see
     * `CloudfrontMonitoringStack`). If omitted, the alarm and its SNS topic are still created,
     * just without an email subscription.
     */
    readonly alarmEmail?: string;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};