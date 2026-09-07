import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfront_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface AppStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly vpc: ec2.IVpc;
    readonly dbSecurityGroup: ec2.SecurityGroup;
    readonly auroraCluster: rds.DatabaseCluster;
    readonly auroraSecret: rds.DatabaseSecret;
    /**
     * CloudFront managed prefix list ID for ALB SG ingress.
     * Falls back to VPC CIDR when omitted.
     */
    readonly cloudfrontManagedPrefixList?: string;
}

/**
 * Application stack: CloudFront (VPC Origin) → Internal ALB → ECS Fargate (nginx)
 *
 * - ALB is internal (not internet-facing), reachable only via CloudFront VPC Origin
 * - ECS service has enableExecuteCommand: true (required for FIS network/memory actions)
 * - ECS tasks are tagged `fis-target: app-service` (propagated from service) for FIS targeting
 * - CloudFront uses an Origin Group: VPC Origin primary → S3 error page fallback
 */
export class AppStack extends cdk.Stack {
    public readonly ecsCluster: ecs.ICluster;
    public readonly ecsService: ecs.FargateService;
    public readonly ecsTaskSecurityGroup: ec2.SecurityGroup;
    public readonly alb: elbv2.ApplicationLoadBalancer;
    public readonly albListener: elbv2.ApplicationListener;
    public readonly distribution: cloudfront.Distribution;

    constructor(scope: Construct, id: string, props: AppStackProps) {
        super(scope, id, props);

        // --- Security Groups ---

        // ALB SG: allowAllOutbound:true avoids a CloudFormation cyclic dependency that
        // arises when ALB egress targets the ECS SG while ECS ingress sources from ALB SG.
        const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
            vpc: props.vpc,
            securityGroupName: `${props.project}-${props.environment}-alb-sg`,
            description: 'Internal ALB ingress from CloudFront VPC Origin only',
            allowAllOutbound: true,
        });
        if (props.cloudfrontManagedPrefixList) {
            albSecurityGroup.addIngressRule(
                ec2.Peer.prefixList(props.cloudfrontManagedPrefixList),
                ec2.Port.tcp(80),
                'CloudFront VPC Origin traffic'
            );
        } else {
            albSecurityGroup.addIngressRule(
                ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
                ec2.Port.tcp(80),
                'VPC CIDR covers CloudFront VPC Origin ENI IPs'
            );
        }

        const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
            vpc: props.vpc,
            securityGroupName: `${props.project}-${props.environment}-ecs-sg`,
            description: 'ECS Fargate tasks ingress from ALB only',
            allowAllOutbound: true,
        });
        ecsSecurityGroup.addIngressRule(
            ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),
            ec2.Port.tcp(80),
            'ALB health check and forwarding'
        );
        this.ecsTaskSecurityGroup = ecsSecurityGroup;

        // --- Internal ALB ---

        this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
            vpc: props.vpc,
            internetFacing: false,
            securityGroup: albSecurityGroup,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });
        cdk.Tags.of(this.alb).add('Role', 'fis-chaos-internal-alb');

        const albLogBucket = new s3.Bucket(this, 'AlbLogBucket', {
            removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
            autoDeleteObjects: props.isAutoDeleteObject,
            enforceSSL: true,
        });
        this.alb.logAccessLogs(albLogBucket);

        this.albListener = this.alb.addListener('HttpListener', {
            port: 80,
            open: false,
        });

        // --- ECS Cluster ---

        this.ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
            vpc: props.vpc,
            clusterName: `${props.project}-${props.environment}-cluster`,
            containerInsightsV2: ecs.ContainerInsights.ENABLED,
        });

        const logGroup = new logs.LogGroup(this, 'AppLogGroup', {
            logGroupName: `/ecs/${props.project}-${props.environment}/app`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Task execution role (ECR pull + CloudWatch logs)
        const executionRole = new iam.Role(this, 'TaskExecutionRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });

        // Task role with SSM Exec permissions (required for ECS Exec and FIS network/memory actions)
        const taskRole = new iam.Role(this, 'TaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            inlinePolicies: {
                EcsExecPolicy: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            actions: [
                                'ssmmessages:CreateControlChannel',
                                'ssmmessages:CreateDataChannel',
                                'ssmmessages:OpenControlChannel',
                                'ssmmessages:OpenDataChannel',
                            ],
                            resources: ['*'],
                        }),
                        new iam.PolicyStatement({
                            actions: [
                                'logs:DescribeLogGroups',
                                'logs:CreateLogStream',
                                'logs:DescribeLogStreams',
                                'logs:PutLogEvents',
                            ],
                            resources: [logGroup.logGroupArn],
                        }),
                    ],
                }),
            },
        });

        // Grant ECS task read access to Aurora credentials secret
        props.auroraSecret.grantRead(taskRole);

        // Task definition: nginx as the demo application
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
            memoryLimitMiB: 512,
            cpu: 256,
            executionRole,
            taskRole,
        });

        const container = taskDefinition.addContainer('app', {
            image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:stable-alpine'),
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'app',
                logGroup,
            }),
            environment: {
                DB_HOST: props.auroraCluster.clusterEndpoint.hostname,
                DB_PORT: '5432',
                DB_NAME: 'appdb',
            },
            healthCheck: {
                command: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'],
                interval: cdk.Duration.seconds(10),
                timeout: cdk.Duration.seconds(5),
                retries: 3,
                startPeriod: cdk.Duration.seconds(10),
            },
        });
        container.addPortMappings({ containerPort: 80 });

        // --- ECS Fargate Service ---
        // Platform 1.4 required for FIS aws:ecs:network-blackhole-port action
        // enableExecuteCommand: true required for FIS SSM-based fault injection
        // propagateTags: SERVICE allows FIS to target tasks by service tags

        const targetGroup = new elbv2.ApplicationTargetGroup(this, 'EcsTg', {
            vpc: props.vpc,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/',
                interval: cdk.Duration.seconds(15),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
                timeout: cdk.Duration.seconds(5),
            },
            deregistrationDelay: cdk.Duration.seconds(30),
        });
        this.albListener.addTargetGroups('EcsTargets', {
            targetGroups: [targetGroup],
        });

        this.ecsService = new ecs.FargateService(this, 'AppService', {
            cluster: this.ecsCluster,
            taskDefinition,
            desiredCount: 2,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroups: [ecsSecurityGroup],
            platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
            enableExecuteCommand: true,
            propagateTags: ecs.PropagatedTagSource.SERVICE,
            circuitBreaker: { rollback: true },
            deploymentController: { type: ecs.DeploymentControllerType.ECS },
        });
        this.ecsService.attachToApplicationTargetGroup(targetGroup);
        // FIS targets ECS tasks by this tag propagated from the service
        cdk.Tags.of(this.ecsService).add('fis-target', 'app-service');

        // --- S3 bucket for CloudFront fallback error page ---

        const errorPageBucket = new s3.Bucket(this, 'ErrorPageBucket', {
            removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
            autoDeleteObjects: props.isAutoDeleteObject,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });
        new s3deploy.BucketDeployment(this, 'ErrorPageDeploy', {
            sources: [
                s3deploy.Source.data(
                    'error.html',
                    '<html><body><h1>Service Temporarily Unavailable</h1><p>We are performing maintenance. Please try again shortly.</p></body></html>'
                ),
            ],
            destinationBucket: errorPageBucket,
        });

        // --- CloudFront Distribution with VPC Origin ---

        const vpcOrigin = cloudfront_origins.VpcOrigin.withApplicationLoadBalancer(this.alb, {
            httpPort: 80,
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            readTimeout: cdk.Duration.seconds(10),
            keepaliveTimeout: cdk.Duration.seconds(5),
        });

        const s3Origin = cloudfront_origins.S3BucketOrigin.withOriginAccessControl(errorPageBucket);

        // Origin Group: VPC Origin (primary) → S3 error page (fallback)
        // Fallback triggers on 5xx from the ALB/ECS — enables CloudFront to serve a
        // maintenance page even if the entire VPC Origin path is unavailable.
        const originGroup = new cloudfront_origins.OriginGroup({
            primaryOrigin: vpcOrigin,
            fallbackOrigin: s3Origin,
            fallbackStatusCodes: [502, 503, 504],
        });

        this.distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: `${props.project}-${props.environment} FIS chaos demo`,
            defaultRootObject: 'index.html',
            defaultBehavior: {
                origin: originGroup,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            },
        });

        new cdk.CfnOutput(this, 'DistributionDomainName', {
            value: this.distribution.distributionDomainName,
            description: 'CloudFront distribution domain name',
        });
        new cdk.CfnOutput(this, 'AlbDnsName', {
            value: this.alb.loadBalancerDnsName,
            description: 'Internal ALB DNS name (VPC-only)',
        });
        new cdk.CfnOutput(this, 'EcsClusterArn', {
            value: this.ecsCluster.clusterArn,
        });
    }
}
