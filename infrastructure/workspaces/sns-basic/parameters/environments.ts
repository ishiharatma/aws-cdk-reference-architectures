import { Environment, EnvironmentConfig  } from "@common/parameters/environments";
import { SnsBasicParams } from 'lib/types';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
    readonly snsBasic?: SnsBasicParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};