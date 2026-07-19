import * as cdk from 'aws-cdk-lib';

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
     * @default 1
     */
    readonly natCount?: number;
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
