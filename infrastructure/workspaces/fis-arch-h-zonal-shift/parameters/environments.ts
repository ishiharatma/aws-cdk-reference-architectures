import { VpcConfig } from '@common/types';
import { Environment, EnvironmentConfig } from '@common/parameters/environments';

export interface EnvParams extends EnvironmentConfig {
    readonly vpcConfig: VpcConfig;
    /**
     * Email address subscribed to FIS experiment stop-condition alarms.
     * Optional — alarms are created regardless; no subscription if omitted.
     */
    readonly alarmEmail?: string;
    /**
     * ASG `AvailabilityZoneImpairmentPolicy.ImpairedZoneHealthCheckBehavior` — how the ASG
     * treats already-running instances in an AZ with an *active* zonal shift:
     *   'ReplaceUnhealthy' — still replaces unhealthy instances, but launches the replacement
     *                        in a healthy AZ instead of the impaired one (this is what makes
     *                        capacity actually move to the healthy AZ).
     *   'IgnoreUnhealthy'  — leaves unhealthy instances in the impaired AZ alone (no churn);
     *                        AWS's own recommendation for "prescaled" capacity plans.
     * Optional, defaults to 'ReplaceUnhealthy' if omitted.
     */
    readonly impairedZoneHealthCheckBehavior?: 'ReplaceUnhealthy' | 'IgnoreUnhealthy';
}

export const params: Partial<Record<Environment, EnvParams>> = {};
