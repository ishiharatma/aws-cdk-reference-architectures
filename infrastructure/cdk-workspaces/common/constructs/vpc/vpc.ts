import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import { Construct } from 'constructs';
import {
    VpcConfig,
    VpcCreateConfig,
    NatType,
    VpcSubnets,
    GatewayVpcEndpointConfig,
    InterfaceVpcEndpointConfig
} from '../../types';
import { pascalCase } from 'change-case-commonjs';
import { CustomNatProvider } from './custom-nat-provider';
import { C_RESOURCE } from '../../constants';

/**
 * VPC Construct Properties
 */
export interface VpcConstructProps {
    readonly project: string;
    readonly environment: string;
    /**
     * VPC configuration (existing VPC or create new VPC)
     */
    readonly config: VpcConfig;
    /**
     * Resource name prefix
     */
    readonly prefix?: string;

    readonly enableSsmParameterOutput?: boolean;
}

/**
 * VPC Construct
 * 
 * This construct supports:
 * - Using an existing VPC
 * - Creating a new VPC with customizable configurations
 * 
 * @example
 * // Using existing VPC
 * new VpcConstruct(this, 'Vpc', {
 *   config: {
 *     existingVpcId: 'vpc-xxxxx'
 *   }
 * });
 * 
 * @example
 * // Creating new VPC
 * new VpcConstruct(this, 'Vpc', {
 *   config: {
 *     createConfig: {
 *       vpcName: 'MyVpc',
 *       cidr: '10.0.0.0/16',
 *       maxAzs: 2,
 *       natCount: 1,
 *       natType: NatType.GATEWAY
 *     }
 *   }
 * });
 */
export class VpcConstruct extends Construct {
    /**
     * The VPC instance
     */
    public readonly vpc: ec2.IVpc;
    public readonly outboundEips: ec2.CfnEIP[];
    public readonly privateSubnets: ec2.ISubnet[];

    constructor(scope: Construct, id: string, props: VpcConstructProps) {
        super(scope, id);

        // Use existing VPC
        if (props.config.existingVpcId) {
            this.vpc = ec2.Vpc.fromLookup(this, 'ImportedVpc', {
                vpcId: props.config.existingVpcId,
            });
            this.privateSubnets = this.vpc.privateSubnets;
            new cdk.CfnOutput(this, 'VpcId', {
                value: this.vpc.vpcId,
                description: 'VPC ID (existing)',
            });
            // Output SSM Parameters
            this._outputSsmParameter(
                props.project,
                props.environment,
                props.enableSsmParameterOutput,
            );

            return;
        }

        // Create new VPC
        if (!props.config.createConfig) {
            throw new Error('Either existingVpcId or createConfig must be specified');
        }

        const config = props.config.createConfig;
        const vpcName = props.prefix 
            ? `${props.prefix}/${config.vpcName}` 
            : config.vpcName;

        // Create specified EIPs
        this.outboundEips = Array.from({ length: config.natCount || 0 }, (_, index) => {
            const eip = new ec2.CfnEIP(this, `Nat${config.natType}Eip${index + 1}`, {
                tags: [{ key: "Name", value: `${props.project}/${props.environment}/Nat${config.natType}EIP${index + 1}` }],
            });
            const shouldRetainEip = config.retainEip ?? false;
            eip.applyRemovalPolicy(
                shouldRetainEip
                    ? cdk.RemovalPolicy.RETAIN 
                    : cdk.RemovalPolicy.DESTROY
            );
            return eip;
        });
        // Determine NAT Gateway provider
        const natGatewayProvider: ec2.NatProvider | undefined = this._createNatProvider(
            props.project,
            props.environment,
            config.natType || NatType.GATEWAY,
            config,
        );

        // Build subnet configuration
        const subnetConfiguration: ec2.SubnetConfiguration[] = config.subnets?.map((subnet: VpcSubnets) => ({
            name: subnet.name,
            subnetType: subnet.subnetType,
            cidrMask: subnet.cidrMask,
        })) || [
            {
                name: 'Public',
                subnetType: ec2.SubnetType.PUBLIC,
                cidrMask: 24,
            },
            {
                name: natGatewayProvider ? 'Private' : 'Isolated',
                subnetType: natGatewayProvider ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PRIVATE_ISOLATED,
                cidrMask: 24,
            },
        ];

        // Create VPC
        this.vpc = new ec2.Vpc(this, C_RESOURCE, {
            vpcName,
            // see: https://docs.aws.amazon.com/vpc/latest/userguide/vpc-cidr-blocks.html#vpc-sizing-ipv4
            ipAddresses: ec2.IpAddresses.cidr(config.cidr),
            maxAzs: config.maxAzs || 3,
            natGateways: config.natCount || 0,
            natGatewayProvider,
            enableDnsHostnames: config.enableDnsHostnames ?? true,
            enableDnsSupport: config.enableDnsSupport ?? true,
            subnetConfiguration,
            createInternetGateway: config.createInternetGateway ?? true,
        });
        this.privateSubnets = this.vpc.privateSubnets;

        // Nat Instance Allowed VPC Traffic and EIP Association
        if (natGatewayProvider) {
            if (config.natType === NatType.INSTANCE) {
                (natGatewayProvider as ec2.NatInstanceProviderV2).connections.allowFrom(
                    ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
                    ec2.Port.allTraffic(),
                    "Allow all traffic from VPC",
                );
            }
            
            natGatewayProvider.configuredGateways.map((nat, index) => {
                if (config.natType === NatType.INSTANCE) {
                    // if NAT type is INSTANCE, associate EIP here
                    if (index < this.outboundEips.length) {
                        // Associate EIP to NAT Instance
                        new ec2.CfnEIPAssociation(this, `NatEipAssociation${index}`, {
                            allocationId: this.outboundEips[index].attrAllocationId,
                            instanceId: nat.gatewayId,
                        });
                    }
                    // Export NAT InstanceID
                    new cdk.CfnOutput(this, `NatInstanceId${index + 1}`, {
                        value: nat.gatewayId,
                    });

                    if (config.natSchedule) {
                        const schedulerRole = new iam.Role(this, `SchedulerRole${index}`, {
                            assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
                            description: 'IAM role for EventBridge Scheduler to start/stop EC2',
                        });

                        schedulerRole.addToPolicy(
                            new iam.PolicyStatement({
                                actions: ['ec2:StartInstances', 'ec2:StopInstances'],
                                resources: [
                                cdk.Stack.of(this).formatArn({
                                    service: 'ec2',
                                    resource: 'instance',
                                    resourceName: nat.gatewayId,
                                }),
                                ],
                            }),
                        );
                        const startTarget = new schedulerTargets.Universal({
                            service: 'ec2',
                            action: 'startInstances',
                            input: scheduler.ScheduleTargetInput.fromObject({
                                InstanceIds: [nat.gatewayId],
                            }),
                            role: schedulerRole,
                        });

                        const stopTarget = new schedulerTargets.Universal({
                            service: 'ec2',
                            action: 'stopInstances',
                            input: scheduler.ScheduleTargetInput.fromObject({
                                InstanceIds: [nat.gatewayId],
                            }),
                            role: schedulerRole,
                        });
                        new scheduler.Schedule(this, `StopSchedule${index}`, {
                                description: `Stop Nat Instance [${nat.gatewayId}]`,
                                schedule: scheduler.ScheduleExpression.expression(
                                    config.natSchedule.stopCronSchedule, config.natSchedule.timeZone),
                                target: stopTarget,
                        });
                        new scheduler.Schedule(this, `StartSchedule${index}`, {
                                description: `Start Nat Instance [${nat.gatewayId}]`,
                                schedule: scheduler.ScheduleExpression.expression(
                                    config.natSchedule.startCronSchedule, config.natSchedule.timeZone),
                                target: startTarget,
                        });
                    }
                }
            });
        }

        // Add Flow Logs if enabled
        if (config.enableFlowLogsToCloudWatch || config.flowLogs) {
            this.vpc.addFlowLog('FlowLog', config.flowLogs || {
            destination: ec2.FlowLogDestination.toCloudWatchLogs(),
            trafficType: ec2.FlowLogTrafficType.ALL,
            });
        }

        // Add Gateway Endpoints
        if (config.gatewayEndpoints) {
            Object.entries(config.gatewayEndpoints).forEach(([key, endpointConfig]: [string, GatewayVpcEndpointConfig]) => {
            this.vpc.addGatewayEndpoint(`${key}Endpoint`, {
            service: endpointConfig.service,
            subnets: endpointConfig.subnets,
            });
            });
        } else {
        // Add default S3 and DynamoDB gateway endpoints
            this.vpc.addGatewayEndpoint('S3Endpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
            });
            this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
            service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
            });
        }

        // Add Interface Endpoints
        if (config.interfaceEndpoints) {
            config.interfaceEndpoints.forEach((endpointConfig: InterfaceVpcEndpointConfig, index: number) => {
            this.vpc.addInterfaceEndpoint(`InterfaceEndpoint${index}`, {
            service: endpointConfig.service,
            subnets: endpointConfig.subnets,
            });
            });
        }

        // Output SSM Parameters
        this._outputSsmParameter(
            props.project,
            props.environment,
            props.enableSsmParameterOutput,
        );

        // Outputs
        new cdk.CfnOutput(this, 'Id', {
            value: this.vpc.vpcId,
            description: `VPC ID for ${vpcName}`,
        });

        new cdk.CfnOutput(this, 'Cidr', {
            value: this.vpc.vpcCidrBlock,
            description: `VPC CIDR for ${vpcName}`,
        });

        new cdk.CfnOutput(this, 'AvailabilityZones', {
            value: cdk.Fn.join(',', this.vpc.availabilityZones),
            description: `Availability Zones for ${vpcName}`,
        });
    }

    /**
     * Output SSM Parameters
     * @param project 
     * @param environment 
     * @param enableSsmParameterOutput  - Whether to output SSM Parameters (default: false)
     */
    private _outputSsmParameter(project: string, environment: string, enableSsmParameterOutput: boolean = false) {
        if (!enableSsmParameterOutput) {
            return;
        }
        /* ─── Parameter Store 出力 ──────────────────────────────────────────*/
        const ssmPrefix = `/${project}/${environment}/network`;

        new ssm.StringParameter(this, 'VpcIdParam', {
        parameterName: `${ssmPrefix}/vpc-id`,
        stringValue: this.vpc.vpcId,
        description: `VPC ID for ${project}-${environment}`,
        });

        new ssm.StringParameter(this, 'SubnetIdsParam', {
        parameterName: `${ssmPrefix}/subnet-ids`,
        stringValue: cdk.Fn.join(
            ',',
            this.privateSubnets.map((s) => s.subnetId)
        ),
        description: `Private Subnet IDs (comma-separated) for ${project}-${environment}`,
        });
    }

    /**
     * Create NAT Provider based on natType
     * @param project 
     * @param environment
     * @param natType 
     * @param config 
     * @returns 
     */
    private _createNatProvider(
        project: string, environment: string, natType: NatType, config: VpcCreateConfig
    ): ec2.NatProvider | undefined {
        let natProvider: ec2.NatProvider | undefined;
        if (natType === NatType.GATEWAY) {
            // NAT Gateway
            natProvider = ec2.NatProvider.gateway({
                eipAllocationIds: this.outboundEips.map((eip) => eip.attrAllocationId),
            });
        } else if (natType === NatType.INSTANCE) {
            // Nat Instance
            natProvider = ec2.NatProvider.instanceV2({
                instanceType: config.natInstanceType
                ? config.natInstanceType
                : ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
                machineImage: ec2.MachineImage.latestAmazonLinux2023({
                edition: ec2.AmazonLinuxEdition.STANDARD,
                cpuType: ec2.AmazonLinuxCpuType.ARM_64, //X86_64,
                }),
                defaultAllowedTraffic: ec2.NatTrafficDirection.OUTBOUND_ONLY,
            });
        } else if (natType === NatType.CUSTOM_INSTANCE) {
            // Custom NAT Instance - create provider before VPC
            const customConfig = config.customNatConfig ?? {};
            
            // Determine key pair
            let keyPair: ec2.IKeyPair | undefined= undefined;
            if (customConfig.existingKeyPair) {
                // Use existing key pair
                keyPair = customConfig.existingKeyPair;
            } else if (customConfig.keyPairName) {
                // Create new key pair
                const keyPairName = customConfig.keyPairName;// ?? `${id.toLowerCase()}-nat-KeyPair`;
                keyPair = new ec2.KeyPair(this, 'KeyPair', {
                    keyPairName: keyPairName,
                    type: ec2.KeyPairType.ED25519,
                    format: ec2.KeyPairFormat.PEM,
                });
            }
            
            // Create CustomNatProvider with configuration
            natProvider = new CustomNatProvider(
                customConfig,
                `${pascalCase(environment)}/${pascalCase(project)}`,
                keyPair ?? undefined,
            );
        } else {
            natProvider = undefined;
        }
        return natProvider;
    }
}
