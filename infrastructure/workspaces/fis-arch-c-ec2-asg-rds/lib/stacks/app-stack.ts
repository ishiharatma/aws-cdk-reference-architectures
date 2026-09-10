import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfront_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface AppStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly vpc: ec2.IVpc;
    readonly auroraCluster: rds.DatabaseCluster;
    readonly auroraSecret: rds.DatabaseSecret;
    /**
     * CloudFront managed prefix list ID for ALB SG ingress.
     * Falls back to VPC CIDR when omitted.
     */
    readonly cloudfrontManagedPrefixList?: string;
}

/**
 * Application stack: CloudFront (VPC Origin) → Internal ALB → EC2 Auto Scaling Group (nginx)
 *
 * EC2 instances run Amazon Linux 2023 with nginx. The SSM agent (pre-installed on AL2023)
 * enables FIS aws:ssm:send-command actions for CPU stress (C-2) and network blackhole (C-4).
 *
 * Instances are tagged fis-target:app-instance so FIS can select them without
 * hard-coding instance IDs or ASG names.
 *
 * CloudFront uses an Origin Group: VPC Origin (primary) → S3 error page (fallback on 5xx).
 */
export class AppStack extends cdk.Stack {
    public readonly asg: autoscaling.AutoScalingGroup;
    public readonly alb: elbv2.ApplicationLoadBalancer;
    public readonly distribution: cloudfront.Distribution;

    constructor(scope: Construct, id: string, props: AppStackProps) {
        super(scope, id, props);

        // --- Security Groups ---

        // ALB SG: ingress from CloudFront VPC Origin (managed prefix list) or VPC CIDR
        const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
            vpc: props.vpc,
            securityGroupName: `${props.project}-${props.environment}-alb-sg`,
            description: 'Internal ALB - ingress from CloudFront VPC Origin only',
            allowAllOutbound: true,
        });
        if (props.cloudfrontManagedPrefixList) {
            albSg.addIngressRule(
                ec2.Peer.prefixList(props.cloudfrontManagedPrefixList),
                ec2.Port.tcp(80),
                'CloudFront VPC Origin traffic',
            );
        } else {
            albSg.addIngressRule(
                ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
                ec2.Port.tcp(80),
                'VPC CIDR covers CloudFront VPC Origin ENI IPs',
            );
        }

        // EC2 SG: ingress from ALB only, full outbound (SSM, package updates, Aurora)
        const ec2Sg = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
            vpc: props.vpc,
            securityGroupName: `${props.project}-${props.environment}-ec2-sg`,
            description: 'EC2 ASG instances - ingress from ALB on port 80',
            allowAllOutbound: true,
        });
        ec2Sg.addIngressRule(
            ec2.Peer.securityGroupId(albSg.securityGroupId),
            ec2.Port.tcp(80),
            'ALB health check and HTTP traffic',
        );

        // --- IAM instance role ---
        // AmazonSSMManagedInstanceCore: required for SSM agent registration.
        // SSM agent must be registered for FIS C-2 (CPU stress) and C-4 (network blackhole).

        const instanceRole = new iam.Role(this, 'InstanceRole', {
            roleName: `${props.project}-${props.environment}-ec2-instance-role`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });
        // Allow EC2 to read Aurora credentials for the demo DB health endpoint
        props.auroraSecret.grantRead(instanceRole);

        // --- EC2 User Data ---
        // Amazon Linux 2023 has SSM agent pre-installed.
        // nginx serves a status page showing instance ID and AZ (via IMDSv2).

        const userData = ec2.UserData.forLinux();
        userData.addCommands(
            'dnf update -y',
            'dnf install -y nginx',
            // Fetch metadata via IMDSv2
            "TOKEN=$(curl -s -X PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600')",
            "INSTANCE_ID=$(curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" http://169.254.169.254/latest/meta-data/instance-id)",
            "AZ=$(curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" http://169.254.169.254/latest/meta-data/placement/availability-zone)",
            // Status page
            'mkdir -p /usr/share/nginx/html',
            'cat > /usr/share/nginx/html/index.html <<HTMLEOF',
            '<!DOCTYPE html><html><head><title>FIS Chaos C</title></head><body>',
            '<h1>FIS Chaos Demo &#8212; Architecture C</h1>',
            '<p>Instance: $INSTANCE_ID</p>',
            '<p>AZ: $AZ</p>',
            '<p>Status: OK</p>',
            '</body></html>',
            'HTMLEOF',
            'systemctl start nginx',
            'systemctl enable nginx',
        );

        // --- Auto Scaling Group ---

        this.asg = new autoscaling.AutoScalingGroup(this, 'AppAsg', {
            vpc: props.vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            minCapacity: 2,
            maxCapacity: 4,
            desiredCapacity: 2,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroup: ec2Sg,
            userData,
            role: instanceRole,
            requireImdsv2: true,
            // ELB health check: ASG replaces instances that fail ALB health checks.
            // Grace period allows nginx to start before checks begin.
            healthCheck: autoscaling.HealthCheck.elb({
                grace: cdk.Duration.minutes(3),
            }),
            // Encrypt root EBS volume (gp3, 20 GB)
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    volume: autoscaling.BlockDeviceVolume.ebs(20, {
                        encrypted: true,
                        volumeType: autoscaling.EbsDeviceVolumeType.GP3,
                    }),
                },
            ],
        });

        // Tag instances for FIS targeting (C-1, C-2, C-4)
        cdk.Tags.of(this.asg).add('fis-target', 'app-instance');

        // --- Internal ALB ---

        this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
            vpc: props.vpc,
            internetFacing: false,
            securityGroup: albSg,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });
        cdk.Tags.of(this.alb).add('Role', 'fis-chaos-c-internal-alb');

        const albLogBucket = new s3.Bucket(this, 'AlbLogBucket', {
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
            autoDeleteObjects: props.isAutoDeleteObject,
            enforceSSL: true,
        });
        this.alb.logAccessLogs(albLogBucket);

        const albListener = this.alb.addListener('HttpListener', {
            port: 80,
            open: false,
        });

        const targetGroup = new elbv2.ApplicationTargetGroup(this, 'AsgTg', {
            vpc: props.vpc,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.INSTANCE,
            healthCheck: {
                path: '/',
                interval: cdk.Duration.seconds(15),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
                timeout: cdk.Duration.seconds(5),
            },
            deregistrationDelay: cdk.Duration.seconds(30),
        });

        albListener.addTargetGroups('AsgTargets', { targetGroups: [targetGroup] });
        this.asg.attachToApplicationTargetGroup(targetGroup);

        // --- S3 fallback error page ---

        const errorPageBucket = new s3.Bucket(this, 'ErrorPageBucket', {
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
            autoDeleteObjects: props.isAutoDeleteObject,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });
        new s3deploy.BucketDeployment(this, 'ErrorPageDeploy', {
            sources: [
                s3deploy.Source.data(
                    'error.html',
                    '<html><body><h1>Service Temporarily Unavailable</h1><p>FIS chaos experiment in progress. Please retry shortly.</p></body></html>',
                ),
            ],
            destinationBucket: errorPageBucket,
        });

        // --- CloudFront Distribution with VPC Origin ---
        // Primary: VPC Origin → Internal ALB
        // Fallback: S3 error page on 502/503/504

        const vpcOrigin = cloudfront_origins.VpcOrigin.withApplicationLoadBalancer(this.alb, {
            httpPort: 80,
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            readTimeout: cdk.Duration.seconds(10),
            keepaliveTimeout: cdk.Duration.seconds(5),
        });

        const s3Origin = cloudfront_origins.S3BucketOrigin.withOriginAccessControl(errorPageBucket);

        const originGroup = new cloudfront_origins.OriginGroup({
            primaryOrigin: vpcOrigin,
            fallbackOrigin: s3Origin,
            fallbackStatusCodes: [502, 503, 504],
        });

        this.distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: `${props.project}-${props.environment} FIS chaos C demo`,
            defaultRootObject: 'index.html',
            defaultBehavior: {
                origin: originGroup,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
                // CloudFront forbids POST/PUT/PATCH/DELETE on a behavior bound to an
                // origin group. The demo workload is a read-only status page, so
                // GET/HEAD/OPTIONS is sufficient.
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            },
        });

        // --- Outputs ---

        new cdk.CfnOutput(this, 'DistributionDomainName', {
            value: this.distribution.distributionDomainName,
            description: 'CloudFront distribution domain name',
        });
        new cdk.CfnOutput(this, 'AlbDnsName', {
            value: this.alb.loadBalancerDnsName,
            description: 'Internal ALB DNS name (VPC-only)',
        });
        new cdk.CfnOutput(this, 'AsgName', {
            value: this.asg.autoScalingGroupName,
            description: 'Auto Scaling Group name',
        });
    }
}
