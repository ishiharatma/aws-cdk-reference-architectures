import { Environment, EnvironmentConfig } from '@common/parameters/environments';
import { SampleWafParams, CwLogsReportParams, AthenaReportParams } from 'lib/types';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
    readonly sampleWaf?: SampleWafParams;
    readonly cwLogsReport?: CwLogsReportParams;
    readonly athenaReport?: AthenaReportParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
