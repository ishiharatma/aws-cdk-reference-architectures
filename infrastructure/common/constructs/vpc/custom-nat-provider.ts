import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { CustomNatInstance } from './custom-nat-instance';
import { CustomNatInstanceConfig } from '../../types/vpc';

/**
 * Custom NAT Provider that creates NAT instances and configures routing
 * 
 * This provider integrates with AWS CDK's VPC construct to:
 * - Create NAT instances in public subnets
 * - Configure routing from private subnets to NAT instances
 * - Support multi-AZ deployments
 * - Enable instance scheduling and monitoring
 * 
 * @export
 * @class CustomNatProvider
 * @extends {ec2.NatProvider}
 */
export class CustomNatProvider extends ec2.NatProvider {
    private readonly instances: CustomNatInstance[] = [];
    private readonly config: CustomNatInstanceConfig;
    private readonly keyPair?: ec2.IKeyPair;
    private readonly namePrefix: string;
    
    /**
     * Creates an instance of CustomNatProvider
     * 
     * @param config Custom NAT instance configuration
     * @param keyPair Key pair for SSH access to NAT instances
     * @param namePrefix Name prefix for resource naming
     */
    constructor(config: CustomNatInstanceConfig, namePrefix: string,keyPair?: ec2.IKeyPair) {
        super();
        this.config = config;
        this.keyPair = keyPair;
        this.namePrefix = namePrefix;
    }

    /**
     * Called by VPC to create NAT instances in public subnets
     * 
     * This method is invoked during VPC construction for each public subnet
     * where a NAT instance should be placed.
     * 
     * @param options Configuration options from VPC including subnets and VPC reference
     */
    public configureNat(options: ec2.ConfigureNatOptions): void {
        const { natSubnets, privateSubnets, vpc } = options;
        
        // Create NAT instance in each provided public subnet
        natSubnets.forEach((publicSubnet, index) => {
            const natInstance = new CustomNatInstance(
                publicSubnet, 
                `NatInstance${index + 1}`, 
                {
                    vpc: vpc,
                    subnet: publicSubnet,
                    instanceType: this.config.instanceType,
                    keyPair: this.keyPair ?? undefined,
                    index: index,
                    cpuType: this.config.cpuType,
                    machineImage: this.config.machineImage,
                    useDefaultUserData: this.config.useDefaultUserData,
                    additionalUserData: this.config.additionalUserData,
                }
            );
            
            this.instances.push(natInstance);
            
            // Configure routes for private subnets in the same AZ
            privateSubnets.forEach((privateSubnet) => {
                if (privateSubnet.availabilityZone === publicSubnet.availabilityZone) {
                    privateSubnet.addRoute(`NatRoute${index}`, {
                        routerId: natInstance.instance.instanceId,
                        routerType: ec2.RouterType.INSTANCE,
                        destinationCidrBlock: '0.0.0.0/0',
                        enablesInternetConnectivity: true,
                    });
                }
            });
        });
    }

    /**
     * Called by VPC to configure routing for private subnets
     * 
     * This method is invoked for each private subnet to add a default route
     * pointing to the appropriate NAT instance based on availability zone.
     * 
     * @param subnet Private subnet that needs NAT routing configured
     */
    public configureSubnet(subnet: ec2.PrivateSubnet): void {
        // Find the NAT instance in the same AZ as this private subnet
        const natInstance = this.instances.find(
            instance => instance.instance.instanceAvailabilityZone === subnet.availabilityZone
        );
        
        if (natInstance) {
            // Add default route to NAT instance in the private subnet's route table
            subnet.addRoute('DefaultRoute', {
                routerId: natInstance.instance.instanceId,
                routerType: ec2.RouterType.INSTANCE,
                destinationCidrBlock: '0.0.0.0/0',
                enablesInternetConnectivity: true,
            });
        }
    }

    /**
     * Returns configured NAT gateways (instances) information
     * 
     * Used for:
     * - Instance scheduling (start/stop)
     * - CloudWatch monitoring
     * - CloudFormation outputs
     * 
     * @returns Array of gateway configurations with instance IDs and availability zones
     */
    public get configuredGateways(): ec2.GatewayConfig[] {
        return this.instances.map((instance) => ({
            gatewayId: instance.instance.instanceId,
            az: instance.instance.instanceAvailabilityZone,
        }));
    }
}
