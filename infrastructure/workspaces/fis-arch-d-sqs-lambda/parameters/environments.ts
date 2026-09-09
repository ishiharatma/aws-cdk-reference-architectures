import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type for the FIS chaos scenarios D workspace
 */
export interface EnvParams extends EnvironmentConfig {
    /**
     * Email address subscribed to FIS experiment stop-condition alarms.
     * Optional — alarms are created regardless; no subscription if omitted.
     */
    readonly alarmEmail?: string;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
