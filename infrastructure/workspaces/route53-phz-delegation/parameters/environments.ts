import { EnvParams } from 'lib/types/route53-phz-delegation-params';
import { Environment } from '@common/parameters/environments';

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
