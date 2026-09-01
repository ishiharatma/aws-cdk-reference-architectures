import { EnvParams } from 'lib/types/route53-resolver-endpoints-params';
import { Environment } from '@common/parameters/environments';

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
