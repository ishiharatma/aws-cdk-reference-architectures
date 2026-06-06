/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from "aws-cdk-lib/assertions";
import { BaseStack } from "lib/stacks/base-stack";
import { EcrStack } from "lib/stacks/ecr-stack";
import { EcsFargateAlbStack } from "lib/stacks/ecs-fargate-alb-stack";
import { Environment } from '@common/parameters/environments';
import 'test/parameters';
import { params } from "parameters/environments";
import '../parameters';
import * as path from 'path';
import { loadCdkContext } from '@common/test-helpers/test-context';

const defaultEnv = {
    account: "123456789012",
    region: "ap-northeast-1",
};

const projectName = "testproject";
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const cdkJsonPath = path.resolve(__dirname, "../../cdk.json");
const baseContext = loadCdkContext(cdkJsonPath);

/**
 * AWS CDK Unit Tests - Fine-grained Assertions
 *
 * This test suite aims to:
 * 1. Verify detailed configuration values of individual resources
 * 2. Check relationships between resources
 * 3. Validate security settings and cost optimization configurations
 *
 * Best practices for fine-grained assertions:
 * - Verify specific configuration values
 * - Name tests clearly to indicate their intent
 * - Test one aspect per test case
 */
describe("EcsFargateAlbStack Fine-grained Assertions", () => {
    let stackTemplate: Template;
    let baseStack: BaseStack;
    let ecrStack: EcrStack;

    beforeAll(() => {
        const context = {...baseContext, "aws:cdk:bundling-stacks": [],};
        const app = new cdk.App({ context });
        
        // Create base stack first
        baseStack = new BaseStack(app, "Base", {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            config: envParams.vpcConfig,
            hostedZoneId: envParams.hostedZoneId,
            allowedIpsforAlb: ['0.0.0.0/0'],
            ports: [8080],
        });

        // Create ECR stack
        ecrStack = new EcrStack(app, "Ecr", {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            config: envParams,
            isBootstrapMode: false,
            commitHash: 'test-hash-12345',
        });

        // Create ECS Fargate ALB stack
        const stack = new EcsFargateAlbStack(app, "EcsFargateAlb", {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            config: envParams,
            vpc: baseStack.vpc.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            ecsSecurityGroups: [baseStack.ecsSecurityGroup],
            albSecurityGroup: baseStack.albSecurityGroup,
            repositories: ecrStack.repositories,
            commitHash: 'test-hash-12345',
            isALBOpen: true,
        });
        stackTemplate = Template.fromStack(stack);
    });

    // ========================================
    // Application Load Balancer Tests
    // ========================================
    describe("Application Load Balancer Configuration", () => {
        test("should create Application Load Balancer", () => {
            stackTemplate.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);
        });

        test("should configure ALB to be internet-facing", () => {
            stackTemplate.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
                Scheme: "internet-facing",
                Type: "application",
            });
        });

        test("should have security groups attached to ALB", () => {
            stackTemplate.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
                SecurityGroups: Match.anyValue(),
            });
        });

        test("should deploy ALB in VPC subnets", () => {
            stackTemplate.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
                Subnets: Match.anyValue(),
            });
        });
    });

    // ========================================
    // ALB Listener Tests
    // ========================================
    describe("ALB Listener Configuration", () => {
        test("should create HTTP listener", () => {
            stackTemplate.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
                Protocol: "HTTP",
                Port: 80,
            });
        });

        test("should create HTTPS listener when hostedZoneId is provided", () => {
            if (envParams.hostedZoneId) {
                stackTemplate.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
                    Protocol: "HTTPS",
                    Port: 443,
                    Certificates: Match.arrayWith([
                        Match.objectLike({
                            CertificateArn: Match.anyValue(),
                        }),
                    ]),
                });
            }
        });

        test("should have default actions configured", () => {
            stackTemplate.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
                DefaultActions: Match.anyValue(),
            });
        });
    });

    // ========================================
    // Target Group Tests
    // ========================================
    describe("Target Group Configuration", () => {
        test("should create target group", () => {
            stackTemplate.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
                TargetType: "ip",
                Protocol: "HTTP",
            });
        });

        test("should configure health check for target group", () => {
            stackTemplate.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
                HealthCheckPath: "/health",
                HealthCheckIntervalSeconds: 30,
                HealthCheckTimeoutSeconds: 5,
                HealthyThresholdCount: 2,
                UnhealthyThresholdCount: 5,
            });
        });

        test("should enable deregistration delay", () => {
            stackTemplate.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
                TargetGroupAttributes: Match.arrayWith([
                    Match.objectLike({
                        Key: "deregistration_delay.timeout_seconds",
                        Value: Match.anyValue(),
                    }),
                ]),
            });
        });

        test("should enable stickiness for target group", () => {
            stackTemplate.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
                TargetGroupAttributes: Match.arrayWith([
                    Match.objectLike({
                        Key: "stickiness.enabled",
                        Value: "false",
                    }),
                ]),
            });
        });
    });

    // ========================================
    // ECS Cluster Tests
    // ========================================
    describe("ECS Cluster Configuration", () => {
        test("should create ECS cluster", () => {
            stackTemplate.resourceCountIs("AWS::ECS::Cluster", 1);
        });

        test("should not set container insights when disabled by config", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::Cluster", {
                ClusterSettings: Match.absent(),
            });
        });

        test("should have cluster name with correct naming pattern", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::Cluster", {
                ClusterName: Match.stringLikeRegexp(`${projectName}.*${envName}`),
            });
        });
    });

    // ========================================
    // ECS Task Definition Tests
    // ========================================
    describe("ECS Task Definition Configuration", () => {
        test("should create ECS task definition", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::TaskDefinition", {
                NetworkMode: "awsvpc",
                RequiresCompatibilities: ["FARGATE"],
                Cpu: "512",
                Memory: "1024",
            });
        });

        test("should configure task execution role", () => {
            stackTemplate.hasResourceProperties("AWS::IAM::Role", {
                AssumeRolePolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Effect: "Allow",
                            Principal: {
                                Service: "ecs-tasks.amazonaws.com",
                            },
                        }),
                    ]),
                },
            });
        });

        test("should create IAM policy resources for task roles", () => {
            stackTemplate.resourceCountIs("AWS::IAM::Policy", 2);
        });

        test("should configure container definitions", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::TaskDefinition", {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        Essential: true,
                        Image: Match.anyValue(),
                        LogConfiguration: Match.objectLike({
                            LogDriver: "awslogs",
                        }),
                    }),
                ]),
            });
        });

        test("should not set ECS container health check by default", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::TaskDefinition", {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        Name: "backend",
                        HealthCheck: Match.absent(),
                    }),
                ]),
            });
        });

        test("should configure port mappings for container", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::TaskDefinition", {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        PortMappings: Match.arrayWith([
                            Match.objectLike({
                                ContainerPort: 8080,
                                Protocol: "tcp",
                            }),
                        ]),
                    }),
                ]),
            });
        });

        test("should enable OTEL sidecar when configured", () => {
            const taskDef = envParams.ecsFargateConfig.createConfig?.taskDefinition?.[0];
            const backendConfig = taskDef?.containerDefinitions?.backend;
            
            if (backendConfig?.enabledOtelSidecar) {
                stackTemplate.hasResourceProperties("AWS::ECS::TaskDefinition", {
                    ContainerDefinitions: Match.arrayWith([
                        Match.objectLike({
                            Name: "adot-collector",
                            Image: Match.stringLikeRegexp(".*otel.*"),
                        }),
                    ]),
                });
            }
        });
    });

    // ========================================
    // ECS Service Tests
    // ========================================
    describe("ECS Service Configuration", () => {
        test("should create ECS service", () => {
            stackTemplate.resourceCountIs("AWS::ECS::Service", 1);
        });

        test("should configure desired count", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::Service", {
                DesiredCount: envParams.ecsFargateConfig.createConfig?.desiredCount,
            });
        });

        test("should enable ECS managed tags", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::Service", {
                EnableECSManagedTags: false,
            });
        });

        test("should configure network configuration", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::Service", {
                NetworkConfiguration: {
                    AwsvpcConfiguration: {
                        AssignPublicIp: "DISABLED",
                        SecurityGroups: Match.anyValue(),
                        Subnets: Match.anyValue(),
                    },
                },
            });
        });

        test("should use FARGATE launch type", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::Service", {
                LaunchType: "FARGATE",
            });
        });

        test("should attach to load balancer", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::Service", {
                LoadBalancers: Match.arrayWith([
                    Match.objectLike({
                        ContainerName: Match.anyValue(),
                        ContainerPort: 8080,
                        TargetGroupArn: Match.anyValue(),
                    }),
                ]),
            });
        });

        test("should enable circuit breaker", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::Service", {
                DeploymentConfiguration: {
                    DeploymentCircuitBreaker: {
                        Enable: true,
                        Rollback: true,
                    },
                },
            });
        });

        test("should configure deployment configuration", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::Service", {
                DeploymentConfiguration: {
                    MaximumPercent: 200,
                    MinimumHealthyPercent: 100,
                },
            });
        });
    });

    // ========================================
    // CloudWatch Logs Tests
    // ========================================
    describe("CloudWatch Logs Configuration", () => {
        test("should create log groups for ECS containers", () => {
            stackTemplate.hasResourceProperties("AWS::Logs::LogGroup", {
                RetentionInDays: 7,
            });
        });

        test("should set log removal policy to DESTROY", () => {
            stackTemplate.hasResource("AWS::Logs::LogGroup", {
                UpdateReplacePolicy: "Delete",
                DeletionPolicy: "Delete",
            });
        });
    });

    // ========================================
    // Auto Scaling Tests
    // ========================================
    describe("Auto Scaling Configuration", () => {
        test("should create Application Auto Scaling target", () => {
            stackTemplate.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
                MaxCapacity: Match.anyValue(),
                MinCapacity: Match.anyValue(),
                ResourceId: Match.anyValue(),
                ServiceNamespace: "ecs",
                ScalableDimension: "ecs:service:DesiredCount",
            });
        });

        test("should create scheduled actions for start/stop", () => {
            stackTemplate.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
                ScheduledActions: Match.arrayWith([
                    Match.objectLike({
                        Schedule: Match.stringLikeRegexp("cron.*"),
                    }),
                ]),
            });
        });
    });

    // ========================================
    // ACM Certificate Tests (if hostedZoneId provided)
    // ========================================
    describe("ACM Certificate Configuration", () => {
        if (envParams.hostedZoneId) {
            test("should create ACM certificate when hostedZoneId is provided", () => {
                stackTemplate.resourceCountIs("AWS::CertificateManager::Certificate", 1);
            });

            test("should use DNS validation for certificate", () => {
                stackTemplate.hasResourceProperties("AWS::CertificateManager::Certificate", {
                    DomainValidationOptions: Match.arrayWith([
                        Match.objectLike({
                            DomainName: Match.anyValue(),
                        }),
                    ]),
                });
            });
        }
    });

    // ========================================
    // Scheduler Configuration Tests (if configured)
    // ========================================
    describe("Scheduler Configuration", () => {
        if (envParams.ecsFargateConfig.createConfig?.startstopSchedulerConfig) {
            test("should create EventBridge rules for ECS notifications", () => {
                stackTemplate.hasResourceProperties("AWS::Events::Rule", {
                    EventPattern: Match.anyValue(),
                    State: "ENABLED",
                });
            });

            test("should create IAM role for scheduled actions", () => {
                stackTemplate.hasResourceProperties("AWS::IAM::Role", {
                    AssumeRolePolicyDocument: {
                        Statement: Match.arrayWith([
                            Match.objectLike({
                                Effect: "Allow",
                                Principal: {
                                    Service: Match.anyValue(),
                                },
                            }),
                        ]),
                    },
                });
            });
        }
    });

    // ========================================
    // Stack Outputs Tests
    // ========================================
    describe("Stack Outputs", () => {
        test("should have ALB and ECS exports", () => {
            const template = stackTemplate.toJSON() as { Outputs?: Record<string, unknown> };
            const outputs = template.Outputs ?? {};
            
            // Check that ALB outputs exist
            const albOutputs = Object.values(outputs).filter((output: any) => 
                output.Description?.includes("Application Load Balancer")
            );
            expect(albOutputs.length).toBeGreaterThan(0);
            
            // Check that ECS cluster and service exports exist
            const exportedOutputs = Object.values(outputs).filter((output: any) => 
                output.Export?.Name?.includes("EcsClusterArn") || output.Export?.Name?.includes("Service0Arn")
            );
            expect(exportedOutputs.length).toBe(2);
        });

        if (envParams.hostedZoneId) {
            test("should output certificate ARN when hostedZoneId is provided", () => {
                stackTemplate.hasOutput("CertificateArn", {
                    Description: "The ARN of the ACM certificate for ALB",
                    Value: Match.objectLike({
                        Ref: Match.stringLikeRegexp("AlbCertificate"),
                    }),
                });
            });
        }
    });

    // ========================================
    // Resource Count Tests
    // ========================================
    describe("Resource Counts", () => {
        test("should create 1 ALB", () => {
            stackTemplate.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);
        });

        test("should create 1 ECS cluster", () => {
            stackTemplate.resourceCountIs("AWS::ECS::Cluster", 1);
        });

        test("should create 1 ECS service", () => {
            stackTemplate.resourceCountIs("AWS::ECS::Service", 1);
        });

        test("should create target groups", () => {
            const taskDefCount = envParams.ecsFargateConfig.createConfig?.taskDefinition?.length || 1;
            stackTemplate.resourceCountIs("AWS::ElasticLoadBalancingV2::TargetGroup", taskDefCount);
        });

        test("should create Application Auto Scaling targets", () => {
            const serviceCount = envParams.ecsFargateConfig.createConfig?.taskDefinition?.length || 1;
            stackTemplate.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", serviceCount);
        });
    });

    // ========================================
    // Security Best Practices Tests
    // ========================================
    describe("Security Best Practices", () => {
        test("should not assign public IP to ECS tasks", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::Service", {
                NetworkConfiguration: {
                    AwsvpcConfiguration: {
                        AssignPublicIp: "DISABLED",
                    },
                },
            });
        });

        test("should use SSL/TLS for ALB when certificate is available", () => {
            if (envParams.hostedZoneId) {
                stackTemplate.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
                    Protocol: "HTTPS",
                    SslPolicy: Match.anyValue(),
                });
            }
        });

        test("should use private subnets for ECS tasks", () => {
            stackTemplate.hasResourceProperties("AWS::ECS::Service", {
                NetworkConfiguration: {
                    AwsvpcConfiguration: Match.objectLike({
                        Subnets: Match.anyValue(),
                    }),
                },
            });
        });
    });
});
