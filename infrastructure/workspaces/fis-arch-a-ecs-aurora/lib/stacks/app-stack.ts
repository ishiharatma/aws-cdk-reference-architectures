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

        // --- SSM Managed-Instance role for the FIS sidecar ---
        // The aws:ecs:task-* FIS actions (A-3 / A-4) drive faults through an SSM
        // document. That requires each task to be registered as an SSM managed
        // instance by an `amazon-ssm-agent` sidecar container. The sidecar calls
        // ssm:CreateActivation with --iam-role pointing at THIS role, which is
        // what the resulting managed instance assumes.
        const ssmManagedInstanceRole = new iam.Role(this, 'SsmManagedInstanceRole', {
            roleName: `${props.project}-${props.environment}-ecs-fis-mi-role`,
            assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
            inlinePolicies: {
                DeregisterOnShutdown: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            actions: [
                                'ssm:DeleteActivation',
                                'ssm:DeregisterManagedInstance',
                            ],
                            resources: ['*'],
                        }),
                    ],
                }),
            },
        });

        // Task role — permissions the FIS SSM sidecar needs to self-register.
        const taskRole = new iam.Role(this, 'TaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            inlinePolicies: {
                FisSidecarPolicy: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            actions: ['ssm:CreateActivation', 'ssm:AddTagsToResource'],
                            resources: ['*'],
                        }),
                        new iam.PolicyStatement({
                            actions: ['iam:PassRole'],
                            resources: [ssmManagedInstanceRole.roleArn],
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

        // Task definition: nginx as the demo application.
        // pidMode: TASK and enableFaultInjection are both required by the
        // aws:ecs:task-network-blackhole-port action (scenarios A-3 / A-4).
        // CPU/memory are sized up from the 256/512 minimum to leave headroom for
        // the SSM sidecar (which runs `dnf upgrade` on start).
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
            memoryLimitMiB: 1024,
            cpu: 512,
            executionRole,
            taskRole,
            // pidMode: TASK requires an explicit runtimePlatform on Fargate.
            runtimePlatform: {
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
                cpuArchitecture: ecs.CpuArchitecture.X86_64,
            },
            pidMode: ecs.PidMode.TASK,
            enableFaultInjection: true,
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

        // --- AWS FIS SSM Agent sidecar ---
        // Verbatim registration script from the AWS FIS user guide
        // (https://docs.aws.amazon.com/fis/latest/userguide/ecs-task-actions.html):
        // creates an SSM activation, registers the task as a managed instance, and
        // deregisters/deletes the activation on SIGTERM. `essential: false` so a
        // sidecar exit does not kill the task.
        const fisSidecarCommand =
            'set -e; dnf upgrade -y; dnf install jq procps awscli -y; ' +
            'term_handler() { echo "Deleting SSM activation $ACTIVATION_ID"; ' +
            'if ! aws ssm delete-activation --activation-id $ACTIVATION_ID --region $ECS_TASK_REGION; then ' +
            'echo "SSM activation $ACTIVATION_ID failed to be deleted" 1>&2; fi; ' +
            'MANAGED_INSTANCE_ID=$(jq -e -r .ManagedInstanceID /var/lib/amazon/ssm/registration); ' +
            'echo "Deregistering SSM Managed Instance $MANAGED_INSTANCE_ID"; ' +
            'if ! aws ssm deregister-managed-instance --instance-id $MANAGED_INSTANCE_ID --region $ECS_TASK_REGION; then ' +
            'echo "SSM Managed Instance $MANAGED_INSTANCE_ID failed to be deregistered" 1>&2; fi; ' +
            'kill -SIGTERM $SSM_AGENT_PID; }; ' +
            'trap term_handler SIGTERM SIGINT; ' +
            'if [[ -z $MANAGED_INSTANCE_ROLE_NAME ]]; then ' +
            'echo "Environment variable MANAGED_INSTANCE_ROLE_NAME not set, exiting" 1>&2; exit 1; fi; ' +
            'if ! ps ax | grep amazon-ssm-agent | grep -v grep > /dev/null; then ' +
            'if [[ -n $ECS_CONTAINER_METADATA_URI_V4 ]] ; then ' +
            'echo "Found ECS Container Metadata, running activation with metadata"; ' +
            'TASK_METADATA=$(curl "${ECS_CONTAINER_METADATA_URI_V4}/task"); ' +
            "ECS_TASK_AVAILABILITY_ZONE=$(echo $TASK_METADATA | jq -e -r '.AvailabilityZone'); " +
            "ECS_TASK_ARN=$(echo $TASK_METADATA | jq -e -r '.TaskARN'); " +
            "ECS_TASK_REGION=$(echo $ECS_TASK_AVAILABILITY_ZONE | sed 's/.$//'); " +
            "ECS_TASK_AVAILABILITY_ZONE_REGEX='^(af|ap|ca|cn|eu|me|sa|us|us-gov)-(central|north|(north(east|west))|south|south(east|west)|east|west)-[0-9]{1}[a-z]{1}$'; " +
            'if ! [[ $ECS_TASK_AVAILABILITY_ZONE =~ $ECS_TASK_AVAILABILITY_ZONE_REGEX ]]; then ' +
            'echo "Error extracting Availability Zone from ECS Container Metadata, exiting" 1>&2; exit 1; fi; ' +
            "ECS_TASK_ARN_REGEX='^arn:(aws|aws-cn|aws-us-gov):ecs:[a-z0-9-]+:[0-9]{12}:task/[a-zA-Z0-9_-]+/[a-zA-Z0-9]+$'; " +
            'if ! [[ $ECS_TASK_ARN =~ $ECS_TASK_ARN_REGEX ]]; then ' +
            'echo "Error extracting Task ARN from ECS Container Metadata, exiting" 1>&2; exit 1; fi; ' +
            'CREATE_ACTIVATION_OUTPUT=$(aws ssm create-activation --iam-role $MANAGED_INSTANCE_ROLE_NAME ' +
            '--tags Key=ECS_TASK_AVAILABILITY_ZONE,Value=$ECS_TASK_AVAILABILITY_ZONE Key=ECS_TASK_ARN,Value=$ECS_TASK_ARN Key=FAULT_INJECTION_SIDECAR,Value=true ' +
            '--region $ECS_TASK_REGION); ' +
            'ACTIVATION_CODE=$(echo $CREATE_ACTIVATION_OUTPUT | jq -e -r .ActivationCode); ' +
            'ACTIVATION_ID=$(echo $CREATE_ACTIVATION_OUTPUT | jq -e -r .ActivationId); ' +
            'if ! amazon-ssm-agent -register -code $ACTIVATION_CODE -id $ACTIVATION_ID -region $ECS_TASK_REGION; then ' +
            'echo "Failed to register with AWS Systems Manager (SSM), exiting" 1>&2; exit 1; fi; ' +
            'amazon-ssm-agent & SSM_AGENT_PID=$!; wait $SSM_AGENT_PID; ' +
            'else echo "ECS Container Metadata not found, exiting" 1>&2; exit 1; fi; ' +
            'else echo "SSM agent is already running, exiting" 1>&2; exit 1; fi';

        taskDefinition.addContainer('amazon-ssm-agent', {
            image: ecs.ContainerImage.fromRegistry(
                'public.ecr.aws/amazon-ssm-agent/amazon-ssm-agent:latest',
            ),
            essential: false,
            entryPoint: ['/bin/bash', '-c'],
            command: [fisSidecarCommand],
            environment: {
                MANAGED_INSTANCE_ROLE_NAME: ssmManagedInstanceRole.roleName,
            },
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'ssm-agent',
                logGroup,
            }),
        });

        // --- ECS Fargate Service ---
        // Platform 1.4 required for the aws:ecs:task-network-blackhole-port action.
        // ECS Exec is deliberately DISABLED: the AWS FIS user guide requires it to
        // be off for aws:ecs:task-* actions (the FIS SSM sidecar provides the agent).
        // propagateTags: SERVICE allows FIS to target tasks by service tags.

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
            enableExecuteCommand: false,
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
                // CloudFront forbids POST/PUT/PATCH/DELETE on a behavior bound to an
                // origin group. The demo workload is a read-only status page, so
                // GET/HEAD/OPTIONS is sufficient.
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
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
