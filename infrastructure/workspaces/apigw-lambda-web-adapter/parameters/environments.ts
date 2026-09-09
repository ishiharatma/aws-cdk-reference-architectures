import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type.
 *
 * This reference needs nothing beyond the shared {@link EnvironmentConfig}
 * (region / accountId / tags), so it is a direct alias. Add members here if a
 * future variant needs per-environment knobs.
 */
export type EnvParams = EnvironmentConfig;

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
