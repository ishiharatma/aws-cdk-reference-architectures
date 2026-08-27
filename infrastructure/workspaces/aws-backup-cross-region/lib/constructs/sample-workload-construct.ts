import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { createAccountRegionalBucket } from '@common/constructs/s3';
import { TestInstance } from '@common/constructs/ec2/ec2-testinstance';

/** Props for {@link SampleWorkloadConstruct}. */
export interface SampleWorkloadConstructProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly backupTagKey: string;
    readonly backupTagValue: string;
}

/**
 * Minimal VPC + EC2 + RDS + S3 workload, each resource tagged with `backupTagKey` /
 * `backupTagValue`. This stands in for "the application AWS Backup protects" in
 * `AwsBackupCrrTokyoStack` — a single tag-based Backup Selection covers all three resource
 * types here (plus the sibling `SampleAppStack`'s CloudFormation stack) without a separate
 * selection per service.
 */
export class SampleWorkloadConstruct extends Construct {
    public readonly vpc: ec2.Vpc;
    public readonly bucket: s3.Bucket;
    public readonly database: rds.DatabaseInstance;

    constructor(scope: Construct, id: string, props: SampleWorkloadConstructProps) {
        super(scope, id);

        this.vpc = new ec2.Vpc(this, 'Vpc', {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
                { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
            ],
        });
        this.vpc.addFlowLog('FlowLog', {
            destination: ec2.FlowLogDestination.toCloudWatchLogs(
                new logs.LogGroup(this, 'FlowLogGroup', {
                    retention: logs.RetentionDays.THREE_DAYS,
                    removalPolicy: cdk.RemovalPolicy.DESTROY,
                }),
            ),
            trafficType: ec2.FlowLogTrafficType.ALL,
        });

        const sampleInstance = new TestInstance(this, 'SampleEc2', {
            project: props.project,
            environment: props.environment,
            vpc: this.vpc,
            targetSubnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        });
        cdk.Tags.of(sampleInstance.instance).add(props.backupTagKey, props.backupTagValue);

        this.bucket = createAccountRegionalBucket({
            scope: this,
            id: 'SampleBucket',
            project: props.project,
            environment: props.environment,
            purpose: 'backup-sample',
            autoDeleteObjects: props.isAutoDeleteObject,
        });
        cdk.Tags.of(this.bucket).add(props.backupTagKey, props.backupTagValue);

        const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
            vpc: this.vpc,
            description: 'Security group for the sample RDS instance',
            allowAllOutbound: false,
        });
        dbSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(3306),
            'Allow MySQL access from within the VPC',
        );

        this.database = new rds.DatabaseInstance(this, 'SampleDatabase', {
            engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            vpc: this.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroups: [dbSecurityGroup],
            credentials: rds.Credentials.fromGeneratedSecret('admin'),
            storageEncrypted: true,
            allocatedStorage: 20,
            multiAz: false,
            deletionProtection: false,
            cloudwatchLogsExports: ['error', 'general', 'slowquery'],
            cloudwatchLogsRetention: logs.RetentionDays.THREE_DAYS,
            // AWS Backup (via the tag-based selection in AwsBackupCrrTokyoStack) is this
            // reference architecture's long-term, cross-region retention mechanism, so RDS's
            // own automated backups are intentionally kept short rather than duplicating it.
            backupRetention: cdk.Duration.days(1),
            removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
        });
        cdk.Tags.of(this.database).add(props.backupTagKey, props.backupTagValue);
    }
}
