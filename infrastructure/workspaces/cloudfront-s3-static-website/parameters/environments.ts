import { VpcConfig } from '@common/types';
import { Environment, EnvironmentConfig  } from "@common/parameters/environments";

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
    /**
     * Whether to enable AWS WAF for the CloudFront distribution.
     * Defaults to false if not specified.
     */
    readonly enableWaf?: boolean;
    /**
     * Two-letter, uppercase ISO 3166-1-alpha-2 country codes to allow via the CloudFront
     * distribution's geo restriction (allowlist). Omit or leave empty to allow all countries.
     * @example ['JP']
     */
    readonly geoRestrictionCountries?: string[];
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};