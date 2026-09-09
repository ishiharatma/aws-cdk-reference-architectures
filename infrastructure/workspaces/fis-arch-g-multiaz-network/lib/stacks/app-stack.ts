import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface AppStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly vpc: ec2.IVpc;
    readonly auroraCluster: rds.DatabaseCluster;
    readonly auroraSecret: rds.DatabaseSecret;
}

/**
 * Application stack: internet-facing Network Load Balancer → EC2 Auto
 * Scaling Group (nginx, 2 AZs) → Aurora PostgreSQL Serverless v2.
 *
 * Unlike Architecture C (ALB), a Network Load Balancer forwards TCP
 * connections at layer 4 rather than terminating them, so it does not
 * automatically hide the client's source address the way an ALB does.
 * This stack disables the NLB's (optional, CDK-managed) security group and
 * disables target-group client-IP preservation instead: with
 * `preserveClientIp: false` the NLB rewrites the source address of traffic
 * reaching the targets to its own node IP (drawn from the target's subnet),
 * so the EC2 security group can simply allow the VPC CIDR — the same
 * pattern used for internal ALB ingress in Architecture C, adapted for an
 * NLB that has no security group of its own to reference.
 *
 * Instances are tagged fis-target:app-instance so FIS (G-4) can select them
 * without hard-coding instance IDs or ASG names.
 */
export class AppStack extends cdk.Stack {
    public readonly asg: autoscaling.AutoScalingGroup;
    public readonly nlb: elbv2.NetworkLoadBalancer;
    public readonly targetGroup: elbv2.NetworkTargetGroup;

    constructor(scope: Construct, id: string, props: AppStackProps) {
        super(scope, id, props);

        // --- Security Groups ---

        // EC2 SG: ingress from the VPC CIDR on port 80. The NLB has no security
        // group of its own (disableSecurityGroups below), and with
        // preserveClientIp:false on the target group, traffic arriving at the
        // instances is source-NAT'd to the NLB node's private IP — which is
        // always within the VPC CIDR.
        const ec2Sg = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
            vpc: props.vpc,
            securityGroupName: `${props.project}-${props.environment}-ec2-sg`,
            description: 'EC2 ASG instances - ingress from NLB (VPC CIDR, source-NAT terminated) on port 80',
            allowAllOutbound: true,
        });
        ec2Sg.addIngressRule(
            ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
            ec2.Port.tcp(80),
            'NLB health check and HTTP traffic (source-NAT terminated at VPC CIDR)',
        );

        // --- IAM instance role ---

        const instanceRole = new iam.Role(this, 'InstanceRole', {
            roleName: `${props.project}-${props.environment}-ec2-instance-role`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });
        // Allow EC2 to read Aurora credentials for the demo DB health endpoint
        props.auroraSecret.grantRead(instanceRole);

        // --- EC2 User Data ---
        // Amazon Linux 2023; nginx serves a status page showing instance ID and AZ
        // (via IMDSv2) so it is easy to see which AZ served a given request during
        // the G-1/G-2 network-disruption experiments.

        const userData = ec2.UserData.forLinux();
        userData.addCommands(
            'dnf update -y',
            'dnf install -y nginx',
            // Fetch metadata via IMDSv2
            "TOKEN=$(curl -s -X PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600')",
            "INSTANCE_ID=$(curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" http://169.254.169.254/latest/meta-data/instance-id)",
            "AZ=$(curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" http://169.254.169.254/latest/meta-data/placement/availability-zone)",
            // Status page
            'mkdir -p /usr/share/nginx/html',
            'cat > /usr/share/nginx/html/index.html <<HTMLEOF',
            '<!DOCTYPE html><html><head><title>FIS Chaos G</title></head><body>',
            '<h1>FIS Chaos Demo &#8212; Architecture G</h1>',
            '<p>Instance: $INSTANCE_ID</p>',
            '<p>AZ: $AZ</p>',
            '<p>Status: OK</p>',
            '</body></html>',
            'HTMLEOF',
            'systemctl start nginx',
            'systemctl enable nginx',
        );

        // --- Auto Scaling Group (2 AZs) ---

        this.asg = new autoscaling.AutoScalingGroup(this, 'AppAsg', {
            vpc: props.vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            minCapacity: 2,
            maxCapacity: 4,
            desiredCapacity: 2,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroup: ec2Sg,
            userData,
            role: instanceRole,
            requireImdsv2: true,
            // ELB health check: ASG replaces instances that fail target-group
            // health checks. Grace period allows nginx to start before checks begin.
            healthCheck: autoscaling.HealthCheck.elb({
                grace: cdk.Duration.minutes(3),
            }),
            // Encrypt root EBS volume (gp3, 20 GB)
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    volume: autoscaling.BlockDeviceVolume.ebs(20, {
                        encrypted: true,
                        volumeType: autoscaling.EbsDeviceVolumeType.GP3,
                    }),
                },
            ],
        });

        // Tag instances for FIS targeting (G-4)
        cdk.Tags.of(this.asg).add('fis-target', 'app-instance');

        // --- Internet-facing Network Load Balancer (2 AZs) ---

        this.nlb = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
            vpc: props.vpc,
            internetFacing: true,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            // Classic NLB behaviour: no security group of its own. EC2 ingress
            // is instead scoped to the VPC CIDR (see InstanceSecurityGroup above).
            disableSecurityGroups: true,
            // Cross-zone load balancing: with it enabled, a request that lands on
            // the AZ-1 NLB node can still be routed to a healthy AZ-2 target when
            // AZ-1 targets are unavailable — this is exactly the behaviour G-1
            // (AZ-1 cross-AZ traffic disruption) and G-2 (AZ-1 total isolation)
            // are designed to probe.
            crossZoneEnabled: true,
        });

        this.targetGroup = new elbv2.NetworkTargetGroup(this, 'AsgTg', {
            vpc: props.vpc,
            port: 80,
            protocol: elbv2.Protocol.TCP,
            targetType: elbv2.TargetType.INSTANCE,
            // Disable client-IP preservation: traffic reaching the targets is
            // source-NAT'd to the NLB node's own (VPC-CIDR) IP, matching the
            // EC2 security group's VPC-CIDR ingress rule above.
            preserveClientIp: false,
            healthCheck: {
                protocol: elbv2.Protocol.HTTP,
                path: '/',
                port: '80',
                interval: cdk.Duration.seconds(10),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 2,
                timeout: cdk.Duration.seconds(6),
            },
            deregistrationDelay: cdk.Duration.seconds(30),
        });

        this.nlb.addListener('TcpListener', {
            port: 80,
            protocol: elbv2.Protocol.TCP,
            defaultTargetGroups: [this.targetGroup],
        });

        this.asg.attachToNetworkTargetGroup(this.targetGroup);

        // --- Outputs ---

        new cdk.CfnOutput(this, 'NlbDnsName', {
            value: this.nlb.loadBalancerDnsName,
            description: 'Internet-facing NLB DNS name',
        });
        new cdk.CfnOutput(this, 'AsgName', {
            value: this.asg.autoScalingGroupName,
            description: 'Auto Scaling Group name',
        });
        new cdk.CfnOutput(this, 'TargetGroupArn', {
            value: this.targetGroup.targetGroupArn,
            description: 'NLB target group ARN (FIS stop-condition metric source)',
        });
    }
}
