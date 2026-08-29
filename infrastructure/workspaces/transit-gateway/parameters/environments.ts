import { TransitGatewayParams } from 'lib/types';
import { Environment } from '@common/parameters/environments';

// Object to store parameters for each environment
export const params: Partial<Record<Environment, TransitGatewayParams>> = {};
