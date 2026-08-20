import { Environment, EnvironmentConfig } from "@common/parameters/environments";
import { EcrCrrParams } from "lib/types";

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
    readonly ecrCrr: EcrCrrParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
