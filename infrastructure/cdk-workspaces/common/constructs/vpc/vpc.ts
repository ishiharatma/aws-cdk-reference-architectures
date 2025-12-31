import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
    VpcConfig,
    VpcCreateConfig,
    NatType,
    VpcSubnets,
    GatewayVpcEndpointConfig,
    InterfaceVpcEndpointConfig
} from '../../types/vpc';
import { pascalCase } from 'change-case-commonjs';
import { CustomNatProvider } from './custom-nat-provider';
import { C_RESOURCE } from '../../types';

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

    constructor(scope: Construct, id: string, props: VpcConstructProps) {
        super(scope, id);

        // Use existing VPC
        if (props.config.existingVpcId) {
            this.vpc = ec2.Vpc.fromLookup(this, 'ImportedVpc', {
                vpcId: props.config.existingVpcId,
            });

            new cdk.CfnOutput(this, 'VpcId', {
                value: this.vpc.vpcId,
                description: 'VPC ID (existing)',
            });

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
            ipAddresses: ec2.IpAddresses.cidr(config.cidr),
            maxAzs: config.maxAzs || 3,
            natGateways: config.natCount || 0,
            natGatewayProvider,
            enableDnsHostnames: config.enableDnsHostnames ?? true,
            enableDnsSupport: config.enableDnsSupport ?? true,
            subnetConfiguration,
            createInternetGateway: config.createInternetGateway ?? true,
        });

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

        // Outputs
        new cdk.CfnOutput(this, 'VpcId', {
            value: this.vpc.vpcId,
            description: `VPC ID for ${vpcName}`,
        });

        new cdk.CfnOutput(this, 'VpcCidr', {
            value: this.vpc.vpcCidrBlock,
            description: `VPC CIDR for ${vpcName}`,
        });

        new cdk.CfnOutput(this, 'AvailabilityZones', {
            value: cdk.Fn.join(',', this.vpc.availabilityZones),
            description: `Availability Zones for ${vpcName}`,
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
