import * as cdk from 'aws-cdk-lib';
import { startstopSchedulerConfig } from './common';

// NAT type
export enum NatType {
    /**
   * NAT Gateway
   */
    GATEWAY = "gateway",
    /**
   * NAT Instance
   */
    INSTANCE = "instance",
    /**
     * Custom NAT (user-defined NAT solution)
     */
    CUSTOM_INSTANCE = "custom"
}

// VPC configuration
export interface VpcConfig {
    /** Existing VPC ID (if not creating a new one) */
    readonly existingVpcId?: string;
    /** VPC creation configuration (if creating a new one) */
    readonly createConfig?: VpcCreateConfig;
}

// VPC creation configuration
export interface VpcCreateConfig {
    /** VPC name */
    readonly vpcName: string;
    /**
     * CIDR block
    * Avoid 172.17.0.0/16 and 172.16.0.0/12 as some AWS services use them
    * @see https://docs.aws.amazon.com/vpc/latest/userguide/vpc-cidr-blocks.html#vpc-sizing-ipv4
    * @example "172.31.0.0/16"
     */
    readonly cidr: string;
    /**
     * Whether to enable IPv6
     * @default false (ipv4 only)
     */
    readonly enableIpv6?: boolean;
    /** Additional CIDR blocks */
    readonly additionalCidrs?: string[];
    /** Flow log configuration */
    readonly enableFlowLogsToCloudWatch?: boolean;
    readonly flowLogs?: cdk.aws_ec2.FlowLogOptions;
    /**
     * Whether to create an Internet Gateway
     * @default true
     */
    readonly createInternetGateway?: boolean;
    /** 
     * Maximum number of Availability Zones
     * @default 3
     */
    readonly maxAzs?: number;
    /**
     * Number of NAT Instances or NAT Gateways
     * @default 0
     */
    readonly natCount?: number;
    /**
     * Type of NAT Instance or NAT Gateway
     * @default NatType.GATEWAY
     */
    readonly natType?: NatType;
    /**
     * Instance type for NAT Instance
     * @default ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO)
     */
    readonly natInstanceType?: cdk.aws_ec2.InstanceType;
    /**
     * Start/stop schedule configuration for NAT Instance/Gateway
     */
    readonly natSchedule?: startstopSchedulerConfig;
    /**
     * Whether to retain EIP for NAT Instance or NAT Gateway
     * @default false
     */
    readonly retainEip?: boolean;
    /**
     * Whether to enable DNS hostnames
     * @default true
     */
    readonly enableDnsHostnames?: boolean;
    /**
     * Whether to enable DNS support
     * @default true
     */
    readonly enableDnsSupport?: boolean;
    /**
     * Subnet configuration
     * @default - No subnets are created
     */
    readonly subnets?: VpcSubnets[];
    /**
     * Gateway endpoint configuration
     * @default - S3 and DynamoDB gateway endpoints are created automatically
     */
    readonly gatewayEndpoints?: Record<string, GatewayVpcEndpointConfig>;
    /**
     * Interface endpoint configuration
     */
    readonly interfaceEndpoints?: InterfaceVpcEndpointConfig[];
    /**
     * Custom NAT instance configuration
     * Only used when natType is NatType.CUSTOM_INSTANCE
     * @default - Use default configuration
     */
    readonly customNatConfig?: CustomNatInstanceConfig;
}

export interface VpcSubnets {
    readonly subnetType: cdk.aws_ec2.SubnetType;
    readonly cidrMask: number;
    readonly name: string;
    // Define additional properties here if needed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}

/**
 * Gateway VPC Endpoint Configuration 
 * @see https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html
 * Gateway endpoints are free, so it's recommended to set them up to reduce communication costs to NAT Gateway
 */
export interface GatewayVpcEndpointConfig {
    readonly service: cdk.aws_ec2.GatewayVpcEndpointAwsService;
    readonly subnets: cdk.aws_ec2.SubnetSelection[];
}

export interface InterfaceVpcEndpointConfig {
    readonly service: cdk.aws_ec2.InterfaceVpcEndpointService;
    readonly subnets: cdk.aws_ec2.SubnetSelection;
}

/**
 * Custom NAT Instance Configuration
 * Used when natType is NatType.CUSTOM_INSTANCE
 */
export interface CustomNatInstanceConfig {
    /**
     * Instance type for custom NAT instance
     * @default ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO)
     */
    readonly instanceType?: cdk.aws_ec2.InstanceType;
    
    /**
     * CPU type for the machine image
     * Only used when machineImage is not specified
     * @default ec2.AmazonLinuxCpuType.ARM_64
     */
    readonly cpuType?: cdk.aws_ec2.AmazonLinuxCpuType;
    
    /**
     * Machine image for the NAT instance
     * If not specified, Amazon Linux 2023 will be used with the specified cpuType
     * @default - Amazon Linux 2023 with cpuType
     */
    readonly machineImage?: cdk.aws_ec2.IMachineImage;
    
    /**
     * Whether to use default NAT configuration user data
     * If false, you must provide custom user data via additionalUserData
     * @default true
     */
    readonly useDefaultUserData?: boolean;
    
    /**
     * Additional user data commands to execute
     * These commands will be appended after the default NAT setup commands (if useDefaultUserData is true)
     * or used as the only user data commands (if useDefaultUserData is false)
     * @default - No additional commands
     */
    readonly additionalUserData?: string[];
    
    /**
     * Key pair name for SSH access
     * If not specified, a new key pair will be created
     * Only used when existingKeyPair is not specified
     * @default - no key pair created
     */
    readonly keyPairName?: string;
    
    /**
     * Existing key pair to use for SSH access
     * If specified, keyPairName will be ignored
     * @default - Create new key pair
     */
    readonly existingKeyPair?: cdk.aws_ec2.IKeyPair;
}