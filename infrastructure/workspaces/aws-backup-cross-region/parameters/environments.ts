import { Environment, EnvironmentConfig } from "@common/parameters/environments";
import { AwsBackupCrrParams } from "lib/types";

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
    readonly awsBackupCrr: AwsBackupCrrParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
