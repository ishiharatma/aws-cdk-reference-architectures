import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { kebabCase, pascalCase } from 'change-case-commonjs';
import { EcsFargateConfig, 
    EcsFargateCreateConfig,
    xrayRepositoryUri,
    otelRepositoryUri,
    xrayTag,
    otelTag } from '../../types/ecs-fargate';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';

interface ValidationResult {
    isValid: boolean;
    errors: string[];
}

/**
 * ECS Fargate Construct Properties
 */
export interface EcsFargateConstructProps {
    readonly project: string;
    readonly environment: string;
    readonly vpc: ec2.IVpc;
    readonly vpcSubnets: ec2.SubnetSelection;
    readonly securityGroups: ec2.ISecurityGroup[];
    /**
     * ECS Fargate configuration (existing cluster or create new cluster)
     */
    readonly config: EcsFargateConfig;
    readonly logRetentionDays: logs.RetentionDays;
    readonly snsAlarmTopic?: sns.ITopic;
    readonly containerEnvironment?: Record<string, string>;
    readonly albListener?: elbv2.IApplicationListener;
}
export class EcsFargateConstruct extends Construct {
    public readonly cluster: ecs.ICluster;
    public readonly services: ecs.IFargateService[] = [];

    constructor(scope: Construct, id: string, props: EcsFargateConstructProps) {
        super(scope, id);

        // Create ECS Fargate Cluster
        this.cluster = this._createEcsFargateCluster(
            props.vpc, props.logRetentionDays, props.config, `${props.project}-${props.environment}-ecs-fargate-cluster`);

        new cdk.CfnOutput(this, 'ClusterArn', {
            value: this.cluster.clusterArn,
            exportName: `${pascalCase(props.project)}${pascalCase(props.environment)}EcsClusterArn`
        });

        const logGroup = new logs.LogGroup(this, 'EcsFargateLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            retention: props.logRetentionDays
        });
        // Create Task Execution Role and Task Role are created by default in FargateTaskDefinition

        // Create ECS Fargate Services for each Task Definition
        if (props.config.createConfig) {
            for (let i = 0; i < props.config.createConfig.taskDefinition.length; i++) {
                const serviceId = `Service${i}`;
                const taskDef = new ecs.FargateTaskDefinition(this, `TaskDef${i}`, {
                    cpu: props.config.createConfig.taskDefinition[i].cpu,
                    memoryLimitMiB: props.config.createConfig.taskDefinition[i].memoryLimitMiB,
                });
                // Add Container Definitions
                // Key is container name
                Object.entries(props.config.createConfig.taskDefinition[i].containerDefinitions).forEach(([containerName, containerDef]) => {
                    if (!containerDef.repositoryName) {
                        throw new Error(`Container repositoryName is not defined for container: ${containerName} in task definition index: ${i}`);
                    }
                    const repositoryName = containerDef.repositoryName;
                    taskDef.addContainer(kebabCase(`container-${containerName}`), {
                        containerName: containerName,
                        image: ecs.ContainerImage.fromEcrRepository(
                            ecr.Repository.fromRepositoryName(this, `${containerName}Repository`, repositoryName),
                            containerDef.imageTag || "latest"
                        ),
                        cpu: containerDef.cpu || 512,
                        memoryLimitMiB: containerDef.memoryLimitMiB || 256,
                        // see: https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/fargate-capacity-providers.html#fargate-capacity-providers-termination
                        stopTimeout: cdk.Duration.seconds(100),
                        essential: true,
                        environment: {
                            ...containerDef.environment,
                            ...props.containerEnvironment,
                            PROJECT: props.project,
                            ENVIRONMENT: props.environment
                        },
                        secrets: containerDef.secrets,
                        logging: ecs.LogDrivers.awsLogs({
                            logGroup,
                            streamPrefix: containerName
                        }),
                        portMappings: [{ containerPort: containerDef.port }]
                    });
                    if (containerDef.enabledOtelSidecar && containerDef.enabledXraySidecar) {
                        console.log(`🚨 Both enabledOtelSidecar and enabledXraySidecar are true for container: ${containerName} in task definition index: ${i}`);
                    }

                    if (containerDef.enabledOtelSidecar) {
                        taskDef.addContainer(kebabCase(`otel-${containerName}`), {
                            containerName: 'adot-collector',
                            // Use AWS public ECR for OpenTelemetry collector instead of private ECR
                            image: ecs.ContainerImage.fromRegistry(`${otelRepositoryUri}:${otelTag}`),
                            cpu: 32,
                            memoryLimitMiB: 256,
                            // see: https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/fargate-capacity-providers.html#fargate-capacity-providers-termination
                            stopTimeout: cdk.Duration.seconds(100),
                            essential: false,
                            logging: ecs.LogDrivers.awsLogs({
                                logGroup,
                                streamPrefix: 'otel'
                            }),
                            portMappings: [{ containerPort: 2000, protocol: ecs.Protocol.UDP }]
                        });
                    } else if (containerDef.enabledXraySidecar) {
                        taskDef.addContainer(kebabCase(`xray-${containerName}`), {
                            containerName: 'Xray',
                            // Use AWS public ECR for X-Ray daemon instead of private ECR
                            image: ecs.ContainerImage.fromRegistry(`${xrayRepositoryUri}:${xrayTag}`),
                            cpu: 32,
                            memoryLimitMiB: 256,
                            // see: https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/fargate-capacity-providers.html#fargate-capacity-providers-termination
                            stopTimeout: cdk.Duration.seconds(100),
                            essential: false,
                            logging: ecs.LogDrivers.awsLogs({
                                logGroup,
                                streamPrefix: 'xray'
                            }),
                            portMappings: [{ containerPort: 2000, protocol: ecs.Protocol.UDP }]
                        });
                    }
                });

                // Create ECS Fargate Service
                const service = this._createEcsFargateService(serviceId,
                    this.cluster,props.config.createConfig,
                    taskDef as ecs.FargateTaskDefinition,
                    props.securityGroups,
                    props.vpcSubnets);
                this.services.push(service);
                //this.serviceDesiredCounts.set(service, props.config.createConfig.desiredCount);
                new cdk.CfnOutput(this, `${serviceId}Arn`, {
                    value: service.serviceArn,
                    exportName: `${pascalCase(props.project)}${pascalCase(props.environment)}${serviceId}Arn`
                });
                // Auto-Scale
                // Initialize scalableTarget if auto-scaling is needed
                let scalableTarget: ecs.ScalableTaskCount | undefined;
                if (props.config.createConfig.autoScalingConfig) {
                    const scalableTarget = service.autoScaleTaskCount({
                        minCapacity: props.config.createConfig.autoScalingConfig.minCapacity,
                        maxCapacity: props.config.createConfig.autoScalingConfig.maxCapacity,
                    });
                    if (props.config.createConfig.autoScalingConfig.requestCountPerTarget) {
                        scalableTarget.scaleOnCpuUtilization('CpuScaling', {
                            targetUtilizationPercent: props.config.createConfig.autoScalingConfig.cpuUtilizationTargetPercent,
                        });
                    }
                }
                // Allow OpenTelemetry/Xray sidecar communication
                service.connections.allowFrom(service.connections, ec2.Port.udp(2000), 
                'Allow OpenTelemetry/Xray sidecar communication');

                if (props.config.createConfig.startstopSchedulerConfig) {
                    this._createTaskScheduler(serviceId,
                        service,
                        props.config.createConfig.desiredCount,
                        props.config.createConfig.startstopSchedulerConfig.startCronSchedule,
                        props.config.createConfig.startstopSchedulerConfig.stopCronSchedule,
                        props.config.createConfig.startstopSchedulerConfig.timeZone,
                        props.config.createConfig.startstopSchedulerConfig.enabledNotification || false,
                        props.snsAlarmTopic
                    );
                }
                // Add to Application Load Balancer Target Group if ALB Listener is provided
                if (props.albListener) {
                    const albListener = props.albListener;
                    const containerDefs = props.config.createConfig.taskDefinition[i].containerDefinitions;
                    let containerIndex = 0;
                    Object.entries(containerDefs).forEach(([containerName, containerDef]) => {
                        // Calculate priority: taskIndex * 100 + containerIndex to avoid conflicts
                        // Allows up to 100 containers per task definition
                        const priority = (i * 100) + containerIndex + 1;
                        containerIndex++;

                        const albConditions: elbv2.ListenerCondition[] = [];
                        if (containerDef.albConditions) {
                            if (containerDef.albConditions.hostHeaders) {
                                albConditions.push(elbv2.ListenerCondition.hostHeaders(containerDef.albConditions.hostHeaders));
                            }
                            if (containerDef.albConditions.pathPatterns) {
                                albConditions.push(elbv2.ListenerCondition.pathPatterns(containerDef.albConditions.pathPatterns));
                            
                            }
                        }
                        // Validate conditions for non-default rules
                        if (!containerDef.albConditions && i > 0) {
                            throw new Error(
                                `Container '${containerName}' in task ${i} requires albConditions. ` +
                                `Only the first task definition can omit conditions to use the default rule.`
                            );
                        }
                        // see: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_elasticloadbalancingv2.ApplicationListener.html#addwbrtargetsid-props
                        const targetGroup = albListener.addTargets(`TargetGroup${i}Container${containerIndex}`, {
                            priority: containerDef.albConditions ? priority : undefined,  // undefined = default rule
                            port: containerDef.port,
                            protocol: elbv2.ApplicationProtocol.HTTP,
                            targets: [service.loadBalancerTarget({
                                containerName: containerName,
                                containerPort: containerDef.port,
                            })],
                            conditions: containerDef.albConditions ? albConditions : undefined,
                            healthCheck: {
                                path: containerDef.healthCheck?.path ?? '/',
                                interval: containerDef.healthCheck?.interval ?? cdk.Duration.seconds(30),
                                timeout: containerDef.healthCheck?.timeout ?? cdk.Duration.seconds(5),
                                healthyThresholdCount: containerDef.healthCheck?.healthyThresholdCount ?? 2,
                                unhealthyThresholdCount: containerDef.healthCheck?.unhealthyThresholdCount ?? 5,
                            },
                            // see: https://docs.aws.amazon.com/cli/latest/reference/elbv2/modify-target-group-attributes.html
                            slowStart: cdk.Duration.seconds(60),
                            // see: https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/fargate-capacity-providers.html#fargate-capacity-providers-termination
                            deregistrationDelay: cdk.Duration.seconds(90),
                        });
                        
                        if (scalableTarget && props.config.createConfig?.autoScalingConfig?.requestCountPerTarget) {
                            scalableTarget.scaleOnRequestCount(`RequestCountScaling${containerName}`, {
                                requestsPerTarget: props.config.createConfig.autoScalingConfig.requestCountPerTarget,
                                targetGroup: targetGroup,
                            });
                        }
                    });
                    // Create CloudWatch Alarms
                    this._createAlarm(service, props.config.createConfig.desiredCount, props.snsAlarmTopic);
                }

            }
        }

    }

    /**
     * Create ECS Fargate Cluster
     * @param vpc 
     * @param logRetentionDays 
     * @param config
     * @param clusterName
     * @param existingClusterArn 
     * @returns 
     */
    private _createEcsFargateCluster(vpc: ec2.IVpc,logRetentionDays: logs.RetentionDays, config: EcsFargateConfig, clusterName?:string): ecs.ICluster {
        if (config.existingClusterArn) {
            // Use existing ECS Fargate Cluster
            return ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
                clusterArn: config.existingClusterArn,
                vpc,
                clusterName: cdk.Fn.select(1, cdk.Fn.split('/', config.existingClusterArn))
            });
        } else {
            // Create new ECS Fargate Cluster
            return new ecs.Cluster(this, 'Cluster', {
                clusterName: clusterName ?? undefined,
                vpc,
                executeCommandConfiguration: {
                    logging: ecs.ExecuteCommandLogging.OVERRIDE,
                    logConfiguration: {
                        cloudWatchLogGroup: new logs.LogGroup(this, 'ExecuteCommandLogGroup', {
                            removalPolicy: cdk.RemovalPolicy.DESTROY,
                            retention: logRetentionDays
                        }),
                        s3Bucket: undefined
                    }
                },
                containerInsightsV2: config.createConfig?.enabledContainerInsight,
            });
        }
    }
    /**
     * Create ECS Fargate Service
     * @param id 
     * @param cluster 
     * @param config 
     * @param taskDefinition 
     * @returns
     */
    private _createEcsFargateService(id:string, cluster: ecs.ICluster,
        config:EcsFargateCreateConfig, taskDefinition: ecs.FargateTaskDefinition,
        securityGroups: ec2.ISecurityGroup[],
        vpcSubnets: ec2.SubnetSelection) : ecs.FargateService {
        return new ecs.FargateService(this, id, {
            cluster,
            platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
            desiredCount: config.desiredCount,
            capacityProviderStrategies: this._configurationCapacityProviderStrategies(
                config.capacityProviderStrategies?.fargateWeight, config.capacityProviderStrategies?.fargateSpotWeight),
            circuitBreaker: {
                rollback: true,
            },
            minHealthyPercent: 100,
            maxHealthyPercent: 200,
            securityGroups: securityGroups,
            vpcSubnets: vpcSubnets,
            taskDefinition,
            enableExecuteCommand: true,
            healthCheckGracePeriod: cdk.Duration.seconds(120),
        });
    }
    /**
     * Configure Capacity Provider Strategies
     * @param fargateWeight
     * @param fargateSpotWeight
     * @returns
     */
    private _configurationCapacityProviderStrategies(fargateWeight?: number,  fargateSpotWeight?: number) : ecs.CapacityProviderStrategy[] | undefined {
        // Configure Capacity Provider Strategies
        // Both weights must be defined to use capacity providers
        if (fargateWeight == null || fargateSpotWeight == null) {
            return undefined;
        }
        // Check validation
        const validation = this._validateCapacityProviderParams(fargateWeight, fargateSpotWeight);
        if (!validation.isValid) {
            throw new Error(`Invalid capacity provider parameters:\n${validation.errors.join("\n")}`);
        }
        if (fargateSpotWeight == 0) {
            return undefined;
        }
        if (fargateWeight == 0) {
            // Use only FARGATE_SPOT
            return [{
                capacityProvider: 'FARGATE_SPOT',
                base: 1,
                weight: fargateSpotWeight,
            }];
        }
        // Use both FARGATE and FARGATE_SPOT
        return [{
            capacityProvider: 'FARGATE',
            base: 1,
            weight: fargateWeight,
        },
        {
            capacityProvider: 'FARGATE_SPOT',
            base: 1,
            weight: fargateSpotWeight,
        }];
    }

    /**
     * Validate capacity provider parameters
     * @param fargateWeight
     * @param fargateSpotWeight
     * @returns
     */
    private _validateCapacityProviderParams(fargateWeight?: number,  fargateSpotWeight?: number): ValidationResult {
        const errors: string[] = [];
        if (fargateWeight == null || fargateSpotWeight == null) {
            return { isValid: true, errors };
        }
        if (fargateWeight < 0) {
            errors.push('fargateWeight must be greater than or equal to 0.');
        }
        if (fargateSpotWeight < 0) {
            errors.push('fargateSpotWeight must be greater than or equal to 0.');
        }
        if (!Number.isInteger(fargateWeight)) {
            errors.push('fargateWeight must be an integer.');
        }
        if (fargateWeight ===0 && fargateSpotWeight ===0) {
            errors.push('Both fargateWeight and fargateSpotWeight cannot be 0.');
        }
        if (errors.length > 0) {
            errors.forEach((error) => {
                cdk.Annotations.of(this).addError(error);
            });
            return { isValid: false, errors };
        }
        return { isValid: true, errors };
    }

    /**
     * Create CloudWatch Alarm for ECS Fargate Service.
     * @param service
     * @param alarmTopic
     */
    private _createAlarm(service: ecs.FargateService, desiredCount: number, alarmTopic?: sns.ITopic) {
        const alarms: cw.Alarm[] = [];
        const alartEvents: events.Rule[] = [];

        // CPU Utilization Alarm
        const cpuUtilizationAlarm = new cw.Alarm(this, 'CpuUtilizationAlarm', {
            alarmDescription: 'Alarm if CPU utilization exceeds 80% for 5 minutes',
            metric: service.metricCpuUtilization({
                period: cdk.Duration.minutes(5),
                statistic: cw.Stats.AVERAGE,
            }),
            threshold: 80,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        alarms.push(cpuUtilizationAlarm);
        // Service Available CPU Utilization Alarm
        const availableCpuUtilizationAlarm = new cw.Alarm(this, 'AvailableCpuUtilizationAlarm', {
            alarmDescription: 'Alarm if Available CPU utilization is less than 0.01% for 5 minutes',
            metric: service.metric('AvailableCpu', {
                period: cdk.Duration.minutes(5),
                statistic: cw.Stats.AVERAGE,
            }),
            threshold: 0.01,
            evaluationPeriods: 2,
            datapointsToAlarm: 1,
            comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        //alarms.push(availableCpuUtilizationAlarm);

        // Memory Utilization Alarm
        const memoryUtilizationAlarm = new cw.Alarm(this, 'MemoryUtilizationAlarm', {
            alarmDescription: 'Alarm if Memory utilization exceeds 80% for 5 minutes',
            metric: service.metricMemoryUtilization({
                period: cdk.Duration.minutes(5),
                statistic: cw.Stats.AVERAGE,
            }),
            threshold: 80,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        alarms.push(memoryUtilizationAlarm);

        const runningTaskCountAlarm = new cw.Alarm(this, 'RunningTaskCountAlarm', {
            alarmDescription: 'Alarm if running task count is less than desired count for 5 minutes',
            metric: new cw.Metric({
                namespace: 'AWS/ECS',
                metricName: 'RunningTaskCount',
                dimensionsMap: {
                    ClusterName: service.cluster.clusterName,
                    ServiceName: service.serviceName,
                },
                period: cdk.Duration.minutes(1),
                statistic: cw.Stats.AVERAGE,
            }),
            threshold: desiredCount - 1,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        alarms.push(runningTaskCountAlarm);

        const unhealthyTargetAlarm = new cw.Alarm(this, 'UnhealthyTargetAlarm', {
            alarmDescription: 'Alarm if there are unhealthy targets in the ECS service',
            metric: service.metric('UnhealthyHostCount', {
                period: cdk.Duration.minutes(1),
                statistic: cw.Stats.MAXIMUM,
            }),
            threshold: 0,
            evaluationPeriods: 2,
            datapointsToAlarm: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        alarms.push(unhealthyTargetAlarm);

        /**
         * ECS Task Abnormal Exit Event Rule
         */
        const taskAbnormalExitAlarm = new events.Rule(this, 'AbnormalTaskExitAlarm', {
            description: 'Alarm if ECS tasks exit abnormally',
            eventPattern: {
                source: ['aws.ecs'],
                detailType: ['ECS Task State Change'],
                detail: {
                    clusterArn: [service.cluster.clusterArn],
                    lastStatus: ['STOPPED'],
                    containers: {
                        exitCode: [{ 'anything-but': 0 }],
                    },
                },
            },
        });
        alartEvents.push(taskAbnormalExitAlarm);

        // Add SNS action to all alarms
        if (alarmTopic) {
            alarms.forEach((alarm) => {
                alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
            });
            alartEvents.forEach((event) => {
                event.addTarget(new eventsTargets.SnsTopic(alarmTopic));
            });
        }
    }

    /**
     * Create Task Scheduler for ECS Fargate Service
     * @param service
     */
    private _createTaskScheduler(id: string, service: ecs.FargateService, desiredCount: number,
        startScheduleExpression: string, stopScheduleExpression: string, timezone: cdk.TimeZone = cdk.TimeZone.ETC_UTC, enabledNotification: boolean, snsTopic?: sns.ITopic) {

        if (!startScheduleExpression || !stopScheduleExpression) {
            return;
        }

        const role = new iam.Role(this, `${id}SchedulerRole`, {
            assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
        });

        role.addToPolicy(new iam.PolicyStatement({
            actions: [
                'ecs:UpdateService',
            ],
            resources: [service.serviceArn],
        }));

        const EcsFargateTarget = {
            Cluster: service.cluster.clusterArn,
            Service: service.serviceName,
        }
        //const eventBus = events.EventBus.fromEventBusName(this, 'DefaultEventBus', 'default');
        // Create Start Schedule
        // ECS UpdateService API call to set desiredCount
        const ecsStopTarget = new schedulerTargets.Universal({
            service: 'ecs',
            action: 'updateService',
            input: scheduler.ScheduleTargetInput.fromObject({
                ...EcsFargateTarget,
                desiredCount: 0
            }),
            role
        });
        const ecsStartTarget = new schedulerTargets.Universal({
            service: 'ecs',
            action: 'updateService',
            input: scheduler.ScheduleTargetInput.fromObject({
                ...EcsFargateTarget,
                desiredCount: desiredCount
            }),
            role
        });
        new scheduler.Schedule(this, `${id}StartSchedule`, {
            description: `Start ECS Fargate Service [${service.serviceName}]`,
            schedule: scheduler.ScheduleExpression.expression(startScheduleExpression, timezone),
            /*
            target: new schedulerTargets.EventBridgePutEvents({
                eventBus: eventBus,
                source: 'ecs.amazonaws.com',
                detailType: 'ECS Fargate Start Service',
                detail: scheduler.ScheduleTargetInput.fromObject({
                    ...EcsFargateTarget,
                    DesiredCount: desiredCount,
                }),
            }),
            */
            target: ecsStartTarget,
            enabled: true,
        });

        // Create Stop Schedule
        new scheduler.Schedule(this, `${id}StopSchedule`, {
            description: `Stop ECS Fargate Service [${service.serviceName}]`,
            schedule: scheduler.ScheduleExpression.expression(stopScheduleExpression, timezone),
            /*
            target: new schedulerTargets.EventBridgePutEvents({
                eventBus: eventBus,
                source: 'ecs.amazonaws.com',
                detailType: 'ECS Fargate Stop Service',
                detail: scheduler.ScheduleTargetInput.fromObject({
                    ...EcsFargateTarget,
                    DesiredCount: 0,
                }),
            }),*/
            target: ecsStopTarget,
            enabled: true,
        });
        /*
        TODO
        if (enabledNotification && snsTopic) {
            // ECS Task State Change Notification Rule
            new events.Rule(this, `${id}SchedulerNotificationRule`, {
                eventBus: eventBus,
                eventPattern: {
                    source: ['ecs.amazonaws.com'],
                    detailType: ['ECS Task State Change'],
                    detail: {
                        clusterArn: [service.cluster.clusterArn],
                    },
                    lastStatus: ['RUNNING', 'STOPPED'],
                    containers: {
                        exitCode: ['0'],
                    },
                },
                targets: [new events.targets.SnsTopic(snsTopic)],
            });
        }*/
    }

}