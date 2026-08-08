import { Environment, EnvironmentConfig  } from "@common/parameters/environments";

/**
 * API Gateway usage plan throttling configuration
 */
export interface ApigwS3StubThrottleParams {
    /** Steady-state requests per second. @default 10 */
    readonly rateLimit?: number;
    /** Maximum burst of concurrent requests. @default 20 */
    readonly burstLimit?: number;
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
    /** API Gateway usage plan throttling. @default { rateLimit: 10, burstLimit: 20 } */
    readonly throttle?: ApigwS3StubThrottleParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};