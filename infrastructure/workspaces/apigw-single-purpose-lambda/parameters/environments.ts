import { Environment, EnvironmentConfig } from '@common/parameters/environments';

export interface EnvParams extends EnvironmentConfig {}

export const params: Partial<Record<Environment, EnvParams>> = {};
