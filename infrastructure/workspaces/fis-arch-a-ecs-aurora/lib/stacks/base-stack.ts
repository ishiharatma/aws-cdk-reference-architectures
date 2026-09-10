import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { VpcConfig } from '@common/types';
import { VpcConstruct } from '@common/constructs/vpc/vpc';

export interface BaseStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly vpcConfig: VpcConfig;
}

/**
 * Base infrastructure stack: VPC and Aurora PostgreSQL Serverless v2.
 *
 * Aurora is provisioned with 1 writer + 1 reader to enable the
 * `aws:rds:failover-db-cluster` FIS action (which requires at least one reader).
 */
export class BaseStack extends cdk.Stack {
    public readonly vpc: ec2.IVpc;
    public readonly dbSecurityGroup: ec2.SecurityGroup;
    public readonly auroraCluster: rds.DatabaseCluster;
    public readonly auroraSecret: rds.DatabaseSecret;

    constructor(scope: Construct, id: string, props: BaseStackProps) {
        super(scope, id, props);

        // VPC: public (NAT GW) / private-with-egress (ALB+ECS) / isolated (Aurora)
        const vpcConstruct = new VpcConstruct(this, 'Vpc', {
            project: props.project,
            environment: props.environment,
            config: props.vpcConfig,
            prefix: [props.project, props.environment].join('/'),
        });
        this.vpc = vpcConstruct.vpc;

        // Security group for Aurora — ingress from VPC CIDR on port 5432.
        // Using VPC CIDR rather than a specific ECS task SG avoids a cross-stack
        // dependency cycle (AppStack → BaseStack VPC; BaseStack → AppStack ECS SG).
        this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
            vpc: this.vpc,
            securityGroupName: `${props.project}-${props.environment}-db-sg`,
            description: 'Aurora PostgreSQL security group - ingress from VPC CIDR on port 5432',
            allowAllOutbound: false,
        });
        this.dbSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(vpcConstruct.vpc.vpcCidrBlock),
            ec2.Port.tcp(5432),
            'Allow PostgreSQL from within the VPC (ECS Fargate tasks)'
        );

        // Aurora PostgreSQL Serverless v2: 1 writer + 1 reader
        // Reader is required for aws:rds:failover-db-cluster FIS action
        const dbSecret = new rds.DatabaseSecret(this, 'AuroraSecret', {
            username: 'postgres',
            secretName: `${props.project}-${props.environment}-aurora-secret`,
        });
        this.auroraSecret = dbSecret;

        this.auroraCluster = new rds.DatabaseCluster(this, 'Aurora', {
            engine: rds.DatabaseClusterEngine.auroraPostgres({
                version: rds.AuroraPostgresEngineVersion.VER_16_13,
            }),
            writer: rds.ClusterInstance.serverlessV2('writer', {
                scaleWithWriter: true,
            }),
            readers: [
                rds.ClusterInstance.serverlessV2('reader1', {
                    scaleWithWriter: true,
                }),
            ],
            serverlessV2MinCapacity: 0.5,
            serverlessV2MaxCapacity: 4,
            vpc: this.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [this.dbSecurityGroup],
            defaultDatabaseName: 'appdb',
            credentials: rds.Credentials.fromSecret(dbSecret),
            removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.SNAPSHOT,
            deletionProtection: !props.isAutoDeleteObject,
            cloudwatchLogsExports: ['postgresql'],
            cloudwatchLogsRetention: logs.RetentionDays.ONE_WEEK,
            storageEncrypted: true,
        });

        new cdk.CfnOutput(this, 'AuroraClusterArn', {
            value: this.auroraCluster.clusterArn,
            description: 'Aurora cluster ARN (FIS failover target)',
        });
        new cdk.CfnOutput(this, 'AuroraEndpoint', {
            value: this.auroraCluster.clusterEndpoint.hostname,
            description: 'Aurora writer endpoint',
        });
    }
}
