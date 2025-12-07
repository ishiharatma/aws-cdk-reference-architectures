/**
 * Environment-specific configurations and type definitions
 */

// Environment enumeration
export enum Environment {
    LOCAL = 'local',
    SANDBOX = 'sandbox',
    DEVELOPMENT = 'dev',
    TEST = 'test',
    STAGING = 'stg',
    PRODUCTION = 'prd',
}

export interface EnvironmentConfig {
    /** Project name */
    //readonly project: string;
    /** Environment type */
    //readonly environment: Environment;
    /** AWS region */
    readonly region?: string;
    /** 
     * AWS Account ID
     * Used to check for inconsistencies between the AWS account ID specified 
     * in the CDK command profile and the statically specified AWS account ID in parameters.
     * Optional if not used for validation.
     * https://docs.aws.amazon.com/cdk/latest/guide/environments.html#region-construct-environments
     */
    readonly accountId?: string;
    /** Stack name prefix */
    readonly stackNamePrefix?: string;

    /** Additional tags */
    readonly tags?: Record<string, string>;
}