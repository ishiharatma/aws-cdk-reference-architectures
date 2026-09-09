import { VpcConfig } from '@common/types';
import { Environment, EnvironmentConfig } from '@common/parameters/environments';

export interface EnvParams extends EnvironmentConfig {
    readonly vpcConfig: VpcConfig;
    /**
     * Email address subscribed to FIS experiment stop-condition alarms.
     * Optional — alarms are created regardless; no subscription if omitted.
     */
    readonly alarmEmail?: string;
}

export const params: Partial<Record<Environment, EnvParams>> = {};
