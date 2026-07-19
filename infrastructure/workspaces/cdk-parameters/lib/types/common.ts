// Common tag definitions
export interface CommonTags {
    Environment: string;
    Project: string;
    Owner?: string;
    CostCenter?: string;
    Application?: string;
}
// Environment enumeration
export enum Environment {
    LOCAL = 'local',
    SANDBOX = 'sandbox',
    DEVELOPMENT = 'dev',
    TEST = 'test',
    STAGING = 'stg',
    PRODUCTION = 'prd',
}