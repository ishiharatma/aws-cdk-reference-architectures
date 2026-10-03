import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { VpcConfig } from '@common/types';
import { VpcConstruct } from '@common/constructs/vpc/vpc';

export interface BaseStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly vpcConfig: VpcConfig;
    readonly dbInstanceClass: string;
    readonly clusterInstanceClass: string;
}

/**
 * Base infrastructure: VPC plus the two RDS Multi-AZ topologies under comparison.
 *
 *   1. Multi-AZ DB *instance*  — 1 primary + 1 synchronous standby (standby is NOT readable).
 *      Failover = DNS flip of the instance endpoint to the standby (typically 60-120 s).
 *   2. Multi-AZ DB *cluster*   — 1 writer + 2 readable standbys in 3 AZs, semi-synchronous.
 *      Failover = a reader is promoted and the cluster endpoint follows (typically ~35 s).
 *
 * Both are plain RDS for PostgreSQL (not Aurora). The Multi-AZ DB cluster has no L2 construct
 * in aws-cdk-lib, so it is defined with the L1 CfnDBCluster.
 */
export class BaseStack extends cdk.Stack {
    public readonly vpc: ec2.IVpc;
    public readonly dbSecurityGroup: ec2.SecurityGroup;
    public readonly dbSecret: rds.DatabaseSecret;
    public readonly multiAzInstance: rds.DatabaseInstance;
    public readonly multiAzClusterIdentifier: string;
    public readonly multiAzClusterArn: string;
    public readonly multiAzClusterEndpoint: string;

    constructor(scope: Construct, id: string, props: BaseStackProps) {
        super(scope, id, props);

        const vpcConstruct = new VpcConstruct(this, 'Vpc', {
            project: props.project,
            environment: props.environment,
            config: props.vpcConfig,
            prefix: [props.project, props.environment].join('/'),
        });
        this.vpc = vpcConstruct.vpc;

        // DB SG: no ingress rules here — the probe stack adds its own SG as the only source.
        this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
            vpc: this.vpc,
            securityGroupName: `${props.project}-${props.environment}-db-sg`,
            description: 'RDS Multi-AZ instance and cluster - ingress from the probe Lambda only',
            allowAllOutbound: false,
        });

        this.dbSecret = new rds.DatabaseSecret(this, 'DbSecret', {
            username: 'postgres',
            secretName: `${props.project}-${props.environment}-rds-secret`,
        });

        const removalPolicy = props.isAutoDeleteObject
            ? cdk.RemovalPolicy.DESTROY
            : cdk.RemovalPolicy.SNAPSHOT;

        const subnetGroup = new rds.SubnetGroup(this, 'DbSubnetGroup', {
            description: `${props.project}-${props.environment} RDS Multi-AZ subnet group`,
            vpc: this.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // --- 1. Multi-AZ DB instance (non-cluster) ---
        this.multiAzInstance = new rds.DatabaseInstance(this, 'MultiAzInstance', {
            instanceIdentifier: `${props.project}-${props.environment}-maz-instance`,
            engine: rds.DatabaseInstanceEngine.postgres({
                version: rds.PostgresEngineVersion.VER_17_9,
            }),
            instanceType: new ec2.InstanceType(props.dbInstanceClass.replace(/^db\./, '')),
            multiAz: true,
            allocatedStorage: 20,
            storageType: rds.StorageType.GP3,
            storageEncrypted: true,
            vpc: this.vpc,
            subnetGroup,
            securityGroups: [this.dbSecurityGroup],
            credentials: rds.Credentials.fromSecret(this.dbSecret),
            databaseName: 'appdb',
            backupRetention: cdk.Duration.days(1),
            deletionProtection: !props.isAutoDeleteObject,
            removalPolicy,
            cloudwatchLogsExports: ['postgresql'],
        });

        // --- 2. Multi-AZ DB cluster (non-Aurora, 1 writer + 2 readable standbys) ---
        this.multiAzClusterIdentifier = `${props.project}-${props.environment}-maz-cluster`;
        const cluster = new rds.CfnDBCluster(this, 'MultiAzCluster', {
            dbClusterIdentifier: this.multiAzClusterIdentifier,
            engine: 'postgres',
            engineVersion: '17.9',
            // Must be explicit: the L1 resource defaults to 3306 even for engine 'postgres'.
            port: 5432,
            // Setting dbClusterInstanceClass is what selects the Multi-AZ DB cluster topology.
            dbClusterInstanceClass: props.clusterInstanceClass,
            allocatedStorage: 20,
            storageType: 'gp3',
            // Do not set iops: RDS rejects IOPS/throughput on gp3 below 400 GiB (baseline 3000 IOPS applies).
            storageEncrypted: true,
            masterUsername: 'postgres',
            // Resolved by CloudFormation at deploy time (dynamic reference), never rendered in the template.
            masterUserPassword: this.dbSecret.secretValueFromJson('password').unsafeUnwrap(),
            databaseName: 'appdb',
            dbSubnetGroupName: subnetGroup.subnetGroupName,
            vpcSecurityGroupIds: [this.dbSecurityGroup.securityGroupId],
            backupRetentionPeriod: 1,
            deletionProtection: !props.isAutoDeleteObject,
            enableCloudwatchLogsExports: ['postgresql'],
        });
        cluster.applyRemovalPolicy(removalPolicy);
        cluster.node.addDependency(subnetGroup);

        this.multiAzClusterArn = cdk.Stack.of(this).formatArn({
            service: 'rds',
            resource: 'cluster',
            resourceName: this.multiAzClusterIdentifier,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        });
        this.multiAzClusterEndpoint = cluster.attrEndpointAddress;

        new cdk.CfnOutput(this, 'MultiAzInstanceIdentifier', {
            value: this.multiAzInstance.instanceIdentifier,
            description: 'Multi-AZ DB instance identifier (FIS I-1 / I-3 target)',
        });
        new cdk.CfnOutput(this, 'MultiAzClusterIdentifier', {
            value: this.multiAzClusterIdentifier,
            description: 'Multi-AZ DB cluster identifier (FIS I-2 target)',
        });
        new cdk.CfnOutput(this, 'MultiAzClusterWriterEndpoint', {
            value: cluster.attrEndpointAddress,
            description: 'Multi-AZ DB cluster writer endpoint',
        });
    }
}
