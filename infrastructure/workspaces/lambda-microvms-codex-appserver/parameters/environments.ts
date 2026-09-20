import { Environment, EnvironmentConfig } from '@common/parameters/environments';
import { MicrovmImageParams, ControlPlaneParams } from 'lib/types';

export interface EnvParams extends EnvironmentConfig {
  readonly microvmImage: MicrovmImageParams;
  readonly controlPlane?: ControlPlaneParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
