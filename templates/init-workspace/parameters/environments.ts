import { VpcConfig } from '@common/types';
import { Environment, EnvironmentConfig  } from "@common/parameters/environments";

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};