import * as cdk from 'aws-cdk-lib';

export interface AuroraConfig {
    /** Existing Aurora cluster identifier (if not creating a new one) */
    readonly existingClusterIdentifier?: string;
    /** Aurora cluster creation configuration (if creating a new one) */
    readonly createConfig?: AuroraCreateConfig;
}

export interface AuroraCreateConfig {
    /** DB cluster identifier */
    readonly clusterIdentifier: string;
    /** Whether to use serverless configuration */
    readonly isServerless: boolean;
    /**
     * DB instance class
     * @default undefined - Not required for serverless configuration
     */
    readonly instanceClass?: cdk.aws_rds.InstanceType;
    /**
     * Serverless V2 minimum capacity
     * @default 0
     */
    readonly serverlessV2MinCapacity?: number;
    /**
     * Serverless V2 maximum capacity
     * @default 0
     */
    readonly serverlessV2MaxCapacity?: number;
    /** DB engine */
    readonly engine: cdk.aws_rds.IClusterEngine;
    /** Multi-AZ deployment */
    readonly isMultiAz?: boolean;
    /** VPC security groups */
    readonly vpcSecurityGroups?: cdk.aws_ec2.ISecurityGroup[];
    /** Subnet group */
    readonly subnetGroup?: cdk.aws_rds.ISubnetGroup;
    /**
     * Whether to enable Performance Insights
     * @default false
     */
    readonly enablePerformanceInsights?: boolean;
    /**
     * Number of reader instances
     * @default 0
     */
    readonly readerInstances?: number;
}