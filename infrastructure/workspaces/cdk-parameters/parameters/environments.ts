import { VpcConfig, Environment } from 'lib/types';

export interface EnvParams {
    readonly region?: string;
    readonly accountId?: string;
    readonly stackNamePrefix?: string;
    readonly tags?: Record<string, string>;
    readonly vpcConfig: VpcConfig;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};