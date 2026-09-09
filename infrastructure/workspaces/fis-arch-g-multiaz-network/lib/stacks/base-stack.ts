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
 * Base infrastructure: 2-AZ VPC and Aurora PostgreSQL Serverless v2.
 *
 * Aurora is provisioned with 1 writer + 1 reader, spread across the two
 * isolated subnets (one per AZ) so that aws:rds:failover-db-cluster (G-3)
 * has a target to promote.
 *
 * The VPC's private-with-egress subnets (one per AZ) are exposed as ARNs
 * because aws:network:disrupt-connectivity (G-1/G-2) targets
 * resourceType `aws:ec2:subnet` directly — there is no tag-based selection
 * for this action, so the FIS templates need the concrete subnet ARN for
 * "AZ-1" (the first AZ returned by the VPC).
 */
export class BaseStack extends cdk.Stack {
    public readonly vpc: ec2.IVpc;
    public readonly dbSecurityGroup: ec2.SecurityGroup;
    public readonly auroraCluster: rds.DatabaseCluster;
    public readonly auroraSecret: rds.DatabaseSecret;

    /**
     * Private-with-egress subnets, one per AZ, ordered to match
     * `vpc.availabilityZones` (index 0 = AZ-1, index 1 = AZ-2).
     */
    public readonly appSubnets: ec2.ISubnet[];

    /**
     * ARNs of `appSubnets`, in the same AZ order. FIS G-1/G-2 target
     * `azSubnetArns[0]` (AZ-1) with `aws:network:disrupt-connectivity`.
     */
    public readonly azSubnetArns: string[];

    constructor(scope: Construct, id: string, props: BaseStackProps) {
        super(scope, id, props);

        // VPC: public (NAT GW) / private-with-egress (EC2 ASG) / isolated (Aurora) — 2 AZs
        const vpcConstruct = new VpcConstruct(this, 'Vpc', {
            project: props.project,
            environment: props.environment,
            config: props.vpcConfig,
            prefix: [props.project, props.environment].join('/'),
        });
        this.vpc = vpcConstruct.vpc;

        // Private-with-egress subnets, one per AZ. `selectSubnets` returns them
        // ordered by AZ, matching `vpc.availabilityZones` — this order is what
        // defines "AZ-1" and "AZ-2" for the FIS network-disruption targets.
        this.appSubnets = this.vpc.selectSubnets({
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        }).subnets;
        this.azSubnetArns = this.appSubnets.map((subnet) =>
            cdk.Stack.of(this).formatArn({
                service: 'ec2',
                resource: 'subnet',
                resourceName: subnet.subnetId,
            }),
        );

        // Aurora SG: ingress from VPC CIDR on port 5432.
        // Using VPC CIDR avoids a cross-stack dependency cycle
        // (AppStack → BaseStack VPC; BaseStack → AppStack EC2 SG).
        this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
            vpc: this.vpc,
            securityGroupName: `${props.project}-${props.environment}-db-sg`,
            description: 'Aurora PostgreSQL SG - ingress from VPC CIDR on port 5432',
            allowAllOutbound: false,
        });
        this.dbSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(5432),
            'Allow PostgreSQL from within the VPC (EC2 ASG instances)',
        );

        // Aurora credentials secret
        const dbSecret = new rds.DatabaseSecret(this, 'AuroraSecret', {
            username: 'postgres',
            secretName: `${props.project}-${props.environment}-aurora-secret`,
        });
        this.auroraSecret = dbSecret;

        // Aurora PostgreSQL Serverless v2: 1 writer + 1 reader, Multi-AZ.
        // CDK places writer/reader instances across the isolated subnets'
        // AZs automatically. The reader is required for G-3
        // (aws:rds:failover-db-cluster) to have a promotion target.
        this.auroraCluster = new rds.DatabaseCluster(this, 'Aurora', {
            engine: rds.DatabaseClusterEngine.auroraPostgres({
                version: rds.AuroraPostgresEngineVersion.VER_16_4,
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
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.SNAPSHOT,
            deletionProtection: !props.isAutoDeleteObject,
            cloudwatchLogsExports: ['postgresql'],
            cloudwatchLogsRetention: logs.RetentionDays.ONE_WEEK,
            storageEncrypted: true,
        });

        new cdk.CfnOutput(this, 'AuroraClusterArn', {
            value: this.auroraCluster.clusterArn,
            description: 'Aurora cluster ARN (FIS G-3 failover target)',
        });
        new cdk.CfnOutput(this, 'AuroraEndpoint', {
            value: this.auroraCluster.clusterEndpoint.hostname,
            description: 'Aurora writer endpoint',
        });
        new cdk.CfnOutput(this, 'Az1SubnetArn', {
            value: this.azSubnetArns[0],
            description: 'AZ-1 private-with-egress subnet ARN (FIS G-1/G-2 target)',
        });
        new cdk.CfnOutput(this, 'Az2SubnetArn', {
            value: this.azSubnetArns[1],
            description: 'AZ-2 private-with-egress subnet ARN',
        });
    }
}
