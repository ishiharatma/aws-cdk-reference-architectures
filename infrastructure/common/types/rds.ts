import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { startstopSchedulerConfig } from './common';

export interface DatabaseConfig {
    /** Existing RDS instance identifier (if not creating a new one) */
//    readonly existingInstanceIdentifier?: string;
    /** RDS instance creation configuration (if creating a new one) */
//    readonly createConfig?: DatabaseCreateConfig;
    readonly rdsInstance?: RDSCreateConfig;
    readonly auroraCluster?: AuroraCreateConfig;
}
//export interface DatabaseCreateConfig {
//    readonly rdsInstance?: RDSCreateConfig;
//    readonly auroraCluster?: AuroraCreateConfig;
//}

export interface databaseCommonConfig {
    /**
     * Snapshot identifier for restoration
     */
    readonly snapshotIdentifier?: string;
    /**
     * Existing database identifier
     */
    readonly existingIdentifier?: string;
    /**
     * Database port
     */
    readonly dbPort?: number;
    /**
     * Default database name
     */
    readonly defaultDatabaseName?: string;
    /**
     * Master username
     */
    readonly masterUsername?: string;
    /**
     * Whether deletion protection is enabled
     */
    readonly deletionProtection?: boolean;
    readonly preferredWindow?: string;
    readonly backupRetention?: number;
    /**
     * Whether to enable Performance Insights
     */
    readonly enablePerformanceInsights?: boolean;
    /**
     * CloudWatch Logs export configuration
     */
    readonly cloudwatchLogsExports?: string[];
    readonly cloudwatchLogsRetentionDays?: number;
    /**
     * Removal policy
     * @default cdk.RemovalPolicy.SNAPSHOT
     */
    readonly removalPolicy?: cdk.RemovalPolicy;
    /**
     * Additional tags
     */
    readonly tags?: Record<string, string>;
}

export interface RDSCreateConfig extends databaseCommonConfig {
    /** DB instance class */
    readonly instanceType: ec2.InstanceType;
    /** DB engine */
    readonly engine: rds.IInstanceEngine;
    /**
     * Multi-AZ deployment
     * @default false
    */
    readonly multiAz?: boolean;
    /** Storage size (GiB) */
    readonly allocatedStorageGiB: number;
    /**
     * Storage type
     * @default rds.StorageType.GP3
     */
    readonly storageType?: rds.StorageType;
    /**
     * Whether to enable replica
     */
    readonly enabledReplica?: boolean;
    /**
     * RDS instance start/stop scheduler configuration
     */
    readonly eventSchedulerConfig?: startstopSchedulerConfig;
}

export interface AuroraCreateConfig extends databaseCommonConfig {

    readonly provisionedConfig?: AuroraProvisionedConfig;
    readonly serverlessV2Config?: AuroraServerlessV2Config;

    /** DB engine */
    readonly engine: rds.IClusterEngine;
    /**
     * Number of reader instances
     * @default 0
     */
    readonly readers?: number;

    /**
     * Whether to enable Data API
     * @default true
     */
    readonly enableDataApi?: boolean;
}

export interface AuroraProvisionedConfig {
    readonly insttanceType: ec2.InstanceType;
    /**
     * RDS instance start/stop scheduler configuration
     */
    readonly eventSchedulerConfig?: startstopSchedulerConfig;
}

export const C_DEFAULT_MIN_CAPACITY = 0; // Default minimum capacity for Aurora Serverless v2
export const C_DEFAULT_MAX_CAPACITY = 8; // Default maximum capacity for Aurora Serverless v2

export interface AuroraServerlessV2Config {
    /**
     * Minimum capacity
     * @default 0
    */
    readonly minCapacity?: number;
    /** 
     * Maximum capacity
     * @default 8
    */
    readonly maxCapacity: number;
    /** Minutes before auto-pause */
    readonly autoPauseDurationMinutes?: number;
}
