import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type.
 *
 * This reference needs nothing beyond the shared {@link EnvironmentConfig} (region / accountId / tags):
 * the pipeline's own knobs live in `app/lib/config.ts` because they are part of the repository content.
 */
export type EnvParams = EnvironmentConfig;

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
