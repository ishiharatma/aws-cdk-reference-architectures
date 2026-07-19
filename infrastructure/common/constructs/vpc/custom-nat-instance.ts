import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Props for CustomNatInstance
 */
export interface CustomNatInstanceProps {
    /**
     * The VPC in which to create the NAT instance
     */
    readonly vpc: ec2.IVpc;
    /**
     * The subnet in which to place the NAT instance
     */
    readonly subnet: ec2.ISubnet;
    /**
     * The instance type for the NAT instance
     * @default ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO)
     */
    readonly instanceType?: ec2.InstanceType;
    /**
     * The key pair to use for SSH access
     */
    readonly keyPair?: ec2.IKeyPair;
    /**
     * Index number for unique resource naming
     */
    readonly index: number;
    /**
     * CPU type for the machine image
     * Only used when machineImage is not specified
     * @default ec2.AmazonLinuxCpuType.ARM_64
     */
    readonly cpuType?: ec2.AmazonLinuxCpuType;
    /**
     * Machine image for the NAT instance
     * If not specified, Amazon Linux 2023 will be used with the specified cpuType
     * @default - Amazon Linux 2023 with cpuType
     */
    readonly machineImage?: ec2.IMachineImage;
    /**
     * Whether to use default NAT configuration user data
     * If false, you must provide custom user data via additionalUserData
     * @default true
     */
    readonly useDefaultUserData?: boolean;
    /**
     * Additional user data commands to execute after NAT configuration
     * These commands will be appended after the default NAT setup commands (if useDefaultUserData is true)
     * or used as the only user data commands (if useDefaultUserData is false)
     * @default - No additional commands
     */
    readonly additionalUserData?: string[];
}

/**
 * Custom NAT Instance Construct
 * 
 * Creates a custom NAT instance with:
 * - Security group with VPC traffic rules
 * - User data for NAT configuration
 * - EC2 instance with IMDSv2 and source/dest check disabled
 * - EIP association
 * 
 * @export
 * @class CustomNatInstance
 * @extends {Construct}
 */
export class CustomNatInstance extends Construct {
    /**
     * The EC2 instance acting as NAT
     */
    public readonly instance: ec2.IInstance;
    
    /**
     * The security group for the NAT instance
     */
    public readonly securityGroup: ec2.ISecurityGroup;

    constructor(scope: Construct, id: string, props: CustomNatInstanceProps) {
        super(scope, id);

        // Create security group for NAT instance
        this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc: props.vpc,
            description: `Security group for NAT instance ${props.index}`,
            allowAllOutbound: true,
        });

        // Allow traffic from VPC
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
            ec2.Port.allTraffic(),
            'Allow all traffic from VPC'
        );

        // Create user data for NAT configuration
        const userData = this.createNatUserData(
            props.useDefaultUserData ?? true,
            props.additionalUserData
        );

        // Determine machine image
        const machineImage = props.machineImage ?? ec2.MachineImage.latestAmazonLinux2023({
            edition: ec2.AmazonLinuxEdition.STANDARD,
            cpuType: props.cpuType ?? ec2.AmazonLinuxCpuType.ARM_64,
        });

        // Determine instance type
        const instanceType = props.instanceType ?? ec2.InstanceType.of(
            ec2.InstanceClass.T4G, 
            ec2.InstanceSize.NANO
        );

        // Create NAT instance
        this.instance = new ec2.Instance(this, 'Instance', {
            instanceName: `${props.vpc.vpcId}/NATInstance${props.index}`,
            vpc: props.vpc,
            instanceType: instanceType,
            ssmSessionPermissions: true,
            machineImage: machineImage,
            keyPair: props.keyPair ?? undefined,
            vpcSubnets: {
                subnets: [props.subnet],
            },
            securityGroup: this.securityGroup,
            userData: userData,
            // Configure IMDSv2 for the NAT instance
            // Security Hub EC2.8
            // https://docs.aws.amazon.com/ja_jp/securityhub/latest/userguide/ec2-controls.html#ec2-8
            requireImdsv2: true,
            // Disable source/destination checks for the NAT instance
            sourceDestCheck: false,
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    mappingEnabled: true,
                    volume: ec2.BlockDeviceVolume.ebs(8, {
                        encrypted: true,
                        volumeType: ec2.EbsDeviceVolumeType.GP3,
                        deleteOnTermination: true,
                    }),
                },
            ],
        });
    }

    /**
     * Create user data for NAT instance configuration
     * @param useDefault - Whether to include default NAT configuration commands
     * @param additionalCommands - Optional additional commands to execute
     * @private
     */
    private createNatUserData(useDefault: boolean, additionalCommands?: string[]): ec2.UserData {
        const userData = ec2.UserData.forLinux({ shebang: '#!/bin/bash' });
        
        // Default NAT configuration commands
        const defaultCommands = [
            'sudo yum install iptables-services -y',
            'sudo systemctl enable iptables',
            'sudo systemctl start iptables',
            'echo net.ipv4.ip_forward=1 >> /etc/sysctl.d/custom-ip-forwarding.conf',
            'sudo sysctl -p /etc/sysctl.d/custom-ip-forwarding.conf',
            'sudo /sbin/iptables -t nat -A POSTROUTING -o $(route | awk \'/^default/{print $NF}\') -j MASQUERADE',
            'sudo /sbin/iptables -F FORWARD',
            'sudo service iptables save',
        ];
        
        // Check for duplicates if both default and additional commands are provided
        if (useDefault && additionalCommands && additionalCommands.length > 0) {
            this.validateNoDuplicates(defaultCommands, additionalCommands);
        }
        
        // Check for duplicates within additional commands
        if (additionalCommands && additionalCommands.length > 0) {
            this.validateNoDuplicatesWithinArray(additionalCommands);
        }
        
        // Add default NAT configuration commands if enabled
        if (useDefault) {
            userData.addCommands(
                // See: https://docs.aws.amazon.com/ja_jp/vpc/latest/userguide/VPC_NAT_Instance.html#create-nat-ami
                ...defaultCommands
            );
        }
        
        // Add additional user data commands if provided
        if (additionalCommands && additionalCommands.length > 0) {
            userData.addCommands(...additionalCommands);
        }
        
        return userData;
    }

    /**
     * Validate that there are no duplicate commands between default and additional commands
     * @param defaultCommands - Default NAT configuration commands
     * @param additionalCommands - Additional user data commands
     * @private
     */
    private validateNoDuplicates(defaultCommands: string[], additionalCommands: string[]): void {
        // Normalize commands for comparison (trim whitespace and ignore comments/empty lines)
        const normalizeCommand = (cmd: string): string => {
            const trimmed = cmd.trim();
            // Ignore comments and empty lines
            if (trimmed.startsWith('#') || trimmed === '') {
                return '';
            }
            return trimmed;
        };

        const normalizedDefaults = defaultCommands
            .map(normalizeCommand)
            .filter(cmd => cmd !== '');
        
        const normalizedAdditional = additionalCommands
            .map(normalizeCommand)
            .filter(cmd => cmd !== '');

        const duplicates: string[] = [];
        normalizedAdditional.forEach(cmd => {
            if (normalizedDefaults.includes(cmd)) {
                duplicates.push(cmd);
            }
        });

        if (duplicates.length > 0) {
            throw new Error(
                `Duplicate user data commands found between default and additional commands:\n` +
                duplicates.map(cmd => `  - ${cmd}`).join('\n') +
                `\n\nPlease remove these commands from additionalUserData or set useDefaultUserData to false.`
            );
        }
    }

    /**
     * Validate that there are no duplicate commands within the array
     * @param commands - Array of commands to check
     * @private
     */
    private validateNoDuplicatesWithinArray(commands: string[]): void {
        const normalizeCommand = (cmd: string): string => {
            const trimmed = cmd.trim();
            if (trimmed.startsWith('#') || trimmed === '') {
                return '';
            }
            return trimmed;
        };

        const normalizedCommands = commands
            .map(normalizeCommand)
            .filter(cmd => cmd !== '');

        const seen = new Set<string>();
        const duplicates: string[] = [];

        normalizedCommands.forEach(cmd => {
            if (seen.has(cmd)) {
                if (!duplicates.includes(cmd)) {
                    duplicates.push(cmd);
                }
            } else {
                seen.add(cmd);
            }
        });

        if (duplicates.length > 0) {
            throw new Error(
                `Duplicate commands found within additionalUserData:\n` +
                duplicates.map(cmd => `  - ${cmd}`).join('\n') +
                `\n\nPlease remove duplicate commands from additionalUserData.`
            );
        }
    }
}
