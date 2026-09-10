import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'lib/types';

export { Environment };

/** Registry of per-environment parameters, populated as a side effect of importing dev/stg/prd-params. */
export const params: Partial<Record<Environment, EnvParams>> = {};
