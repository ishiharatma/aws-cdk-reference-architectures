import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { startstopSchedulerConfig, pathPrefix} from './common';

// see: https://gallery.ecr.aws/xray/aws-xray-daemon
// Support EOL for AWS X-Ray Daemon Docker image
// Maintenance Mode: 2026-02-25
// EOL: 2027-02-25
// https://aws.amazon.com/jp/blogs/news/announcing-aws-x-ray-sdks-daemon-end-of-support-and-opentelemetry-migration/
export const xrayRepositoryUri = 'public.ecr.aws/xray/aws-xray-daemon';
export const xrayTag = 'latest';
// see: https://gallery.ecr.aws/aws-observability/aws-otel-collector
export const otelRepositoryUri = 'public.ecr.aws/aws-observability/aws-otel-collector';
export const otelTag = 'latest';

// ECS Fargate configuration
export interface EcsFargateConfig {
    /** Existing ECS Fargate Cluster ARN (if not creating a new one) */
    readonly existingClusterArn?: string;
    /** ECS Fargate creation configuration (if creating a new one) */
    readonly createConfig?: EcsFargateCreateConfig;
}

// ECS Fargate creation configuration
export interface EcsFargateCreateConfig {
    readonly desiredCount: number;
    readonly capacityProviderStrategies?: FargateCapacityProviderStrategies;
    readonly taskDefinition: taskDefinition[];
    readonly autoScalingConfig?: AutoScalingConfig;
    readonly startstopSchedulerConfig?: startstopSchedulerConfig;
    readonly enabledContainerInsight?: ecs.ContainerInsights;
}

export interface FargateCapacityProviderStrategies {
    readonly fargateWeight?: number;
    readonly fargateSpotWeight?: number;
}

export interface AutoScalingConfig {
    readonly minCapacity: number;
    readonly maxCapacity: number;
    readonly cpuUtilizationTargetPercent: number;
    readonly memoryUtilizationTargetPercent?: number;
    readonly requestCountPerTarget?: number;
}

export interface taskDefinition {
    readonly cpu: number;
    readonly memoryLimitMiB: number;
    readonly containerDefinitions: Record<string, containerDefinition>;
}

export interface containerDefinition {
    /**
     * CPU units for the container
     * @default 512
     */
    readonly cpu?: number;
    /**
     * Memory limit (MiB) for the container
     * @default 256
     */
    readonly memoryLimitMiB?: number;
    //readonly image?: ecs.ContainerImage;
    repositoryName?: string;
    imageTag?: string;
    readonly environment?: Record<string, string>;
    readonly secrets?: Record<string, ecs.Secret>;
    readonly port: number;
    readonly albConditions?: albConditions;
    readonly healthCheck?: healthCheck;
    readonly enabledXraySidecar?: boolean;
    readonly enabledOtelSidecar?: boolean;
}

export interface healthCheck {
    readonly path: string;
    readonly interval?: cdk.Duration;
    readonly timeout?: cdk.Duration;
    readonly healthyThresholdCount?: number;
    readonly unhealthyThresholdCount?: number;
}

export interface albConditions {
    readonly pathPatterns?: pathPrefix[];
    readonly hostHeaders?: string[];
}
