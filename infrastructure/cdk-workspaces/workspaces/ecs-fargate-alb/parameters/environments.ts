import { VpcConfig, EcsFargateConfig, EcrConfig } from '@common/types';
import { Environment, EnvironmentConfig  } from "@common/parameters/environments";

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
    readonly vpcConfig: VpcConfig;
    readonly ecsFargateConfig: EcsFargateConfig;
    readonly ecrConfig: Record<string, EcrConfig>;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};