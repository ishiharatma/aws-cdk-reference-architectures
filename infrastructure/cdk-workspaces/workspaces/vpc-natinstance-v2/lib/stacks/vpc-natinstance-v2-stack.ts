import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sns from "aws-cdk-lib/aws-sns";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cr from "aws-cdk-lib/custom-resources";
import { Environment } from "@common/parameters/environments";
import { pascalCase } from "change-case-commonjs";

export interface StackProps extends cdk.StackProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
  isEIPAssociation?: boolean;
}

export class VpcNatInstanceV2Stack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly outboundEips: string[];//ec2.CfnEIP[];

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const region = cdk.Stack.of(this).region;
    const isEIPAssociation = props.isEIPAssociation ?? false;

    const config = cr.CustomResourceConfig.of(this);
    config.addRemovalPolicy(cdk.RemovalPolicy.DESTROY); // Ensure custom resources are destroyed on stack deletion
    config.addLogRetentionLifetime(logs.RetentionDays.ONE_DAY); // Set log retention for custom resources

    // Create a VPC with custom settings
    const vpcName = [
      pascalCase(props.project), // project name
      pascalCase(props.environment), // environment identifier
      "NatInstanceV2VPC", // purpose
    ]
      .join("/");

    // Create NAT provider instance type
    const natProvider = ec2.NatProvider.instanceV2({
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        edition: ec2.AmazonLinuxEdition.STANDARD,
        cpuType: ec2.AmazonLinuxCpuType.ARM_64, //X86_64,
      }),
      defaultAllowedTraffic: ec2.NatTrafficDirection.OUTBOUND_ONLY,
    });

    this.vpc = new ec2.Vpc(this, "VpcNatInstanceV2", {
      vpcName,
      ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
      maxAzs: 3, // maximum number of AZs to use
      // You can explicitly set availabilityZones here if you need to pin the VPC to specific AZs.
      natGateways: 3, // number of NAT Gateways
      natGatewayProvider: natProvider,
      subnetConfiguration: [
        {
          cidrMask: 26, // 64 IPs per AZ
          name: 'External',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 27, // 32 IPs per AZ
          name: 'Management',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 22, // 1024 IPs per AZ
          name: 'Internal',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 22, // 1024 IPs per AZ
          name: 'Application',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24, // 256 IPs per AZ
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        {
          cidrMask: 28, // 16 IPs per AZ
          name: 'TransitGateway',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ],
    });

    // Security Group for test
    new ec2.SecurityGroup(this, "TestSecurityGroup", {
      vpc: this.vpc,
      description: "Security group for test",
      allowAllOutbound: true,
    });

    // Allow traffic from VPC to NAT instance security group after VPC creation
    (natProvider as ec2.NatInstanceProviderV2).connections.allowFrom(
        ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
        ec2.Port.allTraffic(),
        "Allow all traffic from VPC",
    );

    // Nat Instance Schedule
    const natInstanceScheduleRole = new iam.Role(this, `NatInstanceScheduleRole`, {
        roleName: [props.project, props.environment, 'NatInstanceSchedule'].join('-'),
        assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
        managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonSSMAutomationRole'),
        ]
    });
    // Configure start/stop schedule for NAT instances
    // 💡 if Production environment, it is recommended to specify parameters
    const startCronSchedule = 'cron(0 0 ? * * *)'; // 00:00 UTC daily
    const stopCronSchedule = 'cron(0 9 ? * * *)'; // 09:00 UTC daily
    this.outboundEips = [];
    const natInstanceIds: string[] = [];
    natProvider.configuredGateways.forEach((nat, index) => {
      natInstanceIds.push(nat.gatewayId);

      // Find the NAT Instance resource
      const findNatInstance = this.vpc.node.findAll().find(
        (child) => child instanceof ec2.CfnInstance && (child as ec2.CfnInstance).ref === nat.gatewayId
      ) as ec2.CfnInstance;
      // add Tags to NAT Instance
      if (findNatInstance) {
        cdk.Tags.of(findNatInstance).add('PatchGroup', `/NatInstance/${props.project}/${props.environment}`);
        cdk.Tags.of(findNatInstance).add('AutoPatch', 'true');
        cdk.Tags.of(findNatInstance).add('Role', 'NAT Instance');

        // Add SSM managed policy to NAT Instance role
        const natInstanceRole = this.vpc.node.findAll().find(
          (child) => child instanceof iam.Role && 
                     child.node.path.includes('InstanceRole') &&
                     child.node.path.includes(`ExternalSubnet${index + 1}`)
        ) as iam.Role;
        
        if (natInstanceRole) {
          // Add AmazonSSMManagedInstanceCore policy
          natInstanceRole.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
          );
        }
      }
      // Create EventBridge rules for each NAT instance
      // Start schedule
      new events.CfnRule(this, `EC2StartRule${index + 1}`, {
          name: [props.project, props.environment, 'NATStartRule', nat.gatewayId].join('-'),
          description: `${nat.gatewayId} ${startCronSchedule} Start`,
          scheduleExpression: startCronSchedule,
          targets: [{
              arn: `arn:aws:ssm:${region}::automation-definition/AWS-StartEC2Instance:$DEFAULT`,
              id: 'TargetEC2Instance1',
              input: `{"InstanceId": ["${nat.gatewayId}"]}`,
              roleArn: natInstanceScheduleRole.roleArn
          }]
      });
      // Stop schedule
      new events.CfnRule(this, `EC2StopRule${index + 1}`, {
          name: [props.project, props.environment, 'NATStopRule', nat.gatewayId].join('-'),
          description: `${nat.gatewayId} ${stopCronSchedule} Stop`,
          scheduleExpression: stopCronSchedule,
          targets: [{
              arn: `arn:aws:ssm:${region}::automation-definition/AWS-StopEC2Instance:$DEFAULT`,
              id: 'TargetEC2Instance1',
              input: `{"InstanceId": ["${nat.gatewayId}"]}`,
              roleArn: natInstanceScheduleRole.roleArn
          }]
      });
      // Associate EIP with NAT Instance
      if (isEIPAssociation) {
        const eip = new ec2.CfnEIP(this, `NatEip${index + 1}`, {
            tags: [{ key: "Name", value: `${props.project}/${props.environment}/NatEIP${index + 1}` }],
        });
        eip.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
        new ec2.CfnEIPAssociation(this, `NatEipAssociation${index + 1}`, {
            allocationId: eip.attrAllocationId, // CfnEIPAssociationProps#eip is deprecated.
            instanceId: nat.gatewayId,
        });
        // Output NAT Instance Public IPs
        new cdk.CfnOutput(this, `NatInstance${index + 1}PublicIP`, {
            value: eip.ref,
            description: `Public IP address of NAT Instance ${index + 1}`,
        });
        this.outboundEips.push(eip.ref);
      } else {
        if (findNatInstance) {
          new cdk.CfnOutput(this, `NatInstance${index + 1}PublicIP`, {
            value: findNatInstance.attrPublicIp,
            description: `Public IP address of NAT Instance ${index + 1}`,
          });
          this.outboundEips.push(findNatInstance.attrPublicIp);
        }
      }
    });
    // Create CloudWatch Alarms for NAT Instances
    this._createNatInstanceAlarms(props, natInstanceIds);

    // Create Nofify Rule for Nat Instance status change
    const ec2ChangeStateRule = new events.Rule(this, 'NatInstanceStateChangeRule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: {
          'instance-id': natInstanceIds,
          state: ['stopped', 'terminated', 'shutting-down', 'pending', 'running'],
        },
      },    
    });

    // (Optional) You can implement SNS topic subscription or other notification mechanisms here
    const snsTopic = new sns.Topic(this, 'NatInstanceStateChangeTopic', {
      displayName: `${props.project}-${props.environment}-NatInstanceStateChange`,
      topicName: `${props.project}-${props.environment}-NatInstanceStateChange`,
      enforceSSL: true,
    });

    ec2ChangeStateRule.addTarget(new targets.SnsTopic(snsTopic, {
      message: events.RuleTargetInput.fromObject({
        default: events.EventField.fromPath('$.detail'),
        subject: `[${props.project.toUpperCase()}-${props.environment.toUpperCase()}] NAT Instance State Changed`,
        message: {
          summary: `NAT Instance state changed to ${events.EventField.fromPath('$.detail.state')}`,
          details: {
            instanceId: events.EventField.fromPath('$.detail.instance-id'),
            state: events.EventField.fromPath('$.detail.state'),
            time: events.EventField.fromPath('$.time'),
            region: events.EventField.fromPath('$.region'),
            account: events.EventField.fromPath('$.account'),
          },
          metadata: {
            project: props.project,
            environment: props.environment,
          },
        },
      }),
    }));

    // Create Patch Management for NAT Instances
    this._createPatchManagement(props, natInstanceIds);

    // add Flow Logs exporting to S3
    const flowLogBucket = new s3.Bucket(this, "FlowLogBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // NOT recommended for production use
      autoDeleteObjects: true, // NOT recommended for production use
    });
    
    this.vpc.addFlowLog("FlowLogToS3", {
      destination: ec2.FlowLogDestination.toS3(
        flowLogBucket,
        'vpcFlowLog/',
        {
          fileFormat: ec2.FlowLogFileFormat.PLAIN_TEXT,
          hiveCompatiblePartitions: true,
          perHourPartition: true,
        }
      ),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });
    // add Flow Logs exporting to CloudWatch Logs
    // Only reject traffic
    this.vpc.addFlowLog("FlowLog", {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, "FlowLogGroup", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        })
      ),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });

    const endpointSubnets = this.vpc.selectSubnets({
      subnetGroupName: 'Internal',
    });
    if (endpointSubnets.subnets.length === 0) {
      throw new Error('No subnets found for subnet group "Internal"');
    }
    // Gateway Endpoints
    // see: https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html
    // add VPC Gateway Endpoint for S3
    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnets: endpointSubnets.subnets }],
    });
    // add VPC Endpoint for DynamoDB
    this.vpc.addGatewayEndpoint("DynamoDbEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      subnets: [{ subnets: endpointSubnets.subnets }],
    });

    // Interface Endpoints
    // for Systems Manager
    // see: https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-create-vpc.html#create-vpc-endpoints
    this.vpc.addInterfaceEndpoint("SSMEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: {
        subnets: endpointSubnets.subnets,
      },
    });
    this.vpc.addInterfaceEndpoint("SSMMessagesEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      subnets: {
        subnets: endpointSubnets.subnets,
      },
    });
    // SSM Agent version 3.3.40 or later is not required
    /*
    this.vpc.addInterfaceEndpoint("EC2MessagesEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      subnets: {
        subnets: endpointSubnets.subnets,
      },
    });
    */

    // for Instance Connect Endpoint
    // see: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-with-ec2-instance-connect-endpoint.html
    const ec2InstanceConnectsg = new ec2.SecurityGroup(this, "EC2InstanceConnectSG", {
      vpc: this.vpc,
      description: "Security group for EC2 Instance Connect Endpoint",
      allowAllOutbound: false,
    });

    // Instance Connect Endpoint in the first InternalSubnet
    // Because Maximum number of EC2 Instance Connect Endpoints per VPC is 1
    // see: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/eice-quotas.html
    const iceSubnet = endpointSubnets.subnets[0];
    new ec2.CfnInstanceConnectEndpoint(this, "EC2InstanceConnectEndpoint", {
      subnetId: iceSubnet.subnetId,
      preserveClientIp: false,
      securityGroupIds: [ec2InstanceConnectsg.securityGroupId],
    });

    const ec2sg = new ec2.SecurityGroup(this, "EC2SG", {
      vpc: this.vpc,
      description: "Security group for EC2 instances",
      allowAllOutbound: true,
    });

    // Allow Instance Connect access with mutual security group references
    // Use CfnSecurityGroupIngress/Egress to avoid circular dependencies
    // ⚠️if use addIngressRule/addEgressRule, it will create circular dependency between the two security groups
    // Ingress: Instance Connect SG -> EC2 SG
    new ec2.CfnSecurityGroupIngress(this, "AllowSSHFromInstanceConnect", {
      ipProtocol: "tcp",
      fromPort: 22,
      toPort: 22,
      groupId: ec2sg.securityGroupId,
      sourceSecurityGroupId: ec2InstanceConnectsg.securityGroupId,
      description: "Allow SSH from Instance Connect SG",
    });
    // Egress: Instance Connect SG -> EC2 SG
    new ec2.CfnSecurityGroupEgress(this, "AllowSSHToEC2SG", {
      ipProtocol: "tcp",
      fromPort: 22,
      toPort: 22,
      groupId: ec2InstanceConnectsg.securityGroupId,
      destinationSecurityGroupId: ec2sg.securityGroupId,
      description: "Allow SSH to EC2 SG",
    });
    // Circular dependency can be avoided by using addIngressRule/addEgressRule, but it is commented out here
    /*
    ec2sg.addIngressRule(
      ec2.Peer.securityGroupId(ec2InstanceConnectsg.securityGroupId),
      ec2.Port.tcp(22),
      "Allow SSH from Instance Connect SG"
    );
    ec2InstanceConnectsg.addEgressRule(
      ec2.Peer.securityGroupId(ec2sg.securityGroupId),
      ec2.Port.tcp(22),
      "Allow SSH to EC2 SG"
    );
    */
  }

  /**
   * Create Patch Management for NAT Instances
   * @param props 
   * @param natInstanceIds 
   */
  private _createPatchManagement(props: StackProps, natInstanceIds: string[]) {
    // Create Patch Notification Topic
    const patchNotificationTopic = new sns.Topic(this, 'NatInstancePatchNotificationTopic', {
      displayName: `${props.project}-${props.environment}-NatInstancePatchNotification`,
      topicName: `${props.project}-${props.environment}-NatInstancePatchNotification`,
      enforceSSL: true,
    });
    // NAT Instance Patch Management
    // 1. Create SSM Patch Baseline for Amazon Linux 2023
    const patchBaseline = new ssm.CfnPatchBaseline(this, 'NatInstancePatchBaseline', {
      name: `${props.project}-${props.environment}-NatInstancePatchBaseline`,
      operatingSystem: 'AMAZON_LINUX_2023',
      patchGroups: [`/NatInstance/${props.project}/${props.environment}`],
      approvalRules: {
        patchRules: [
          {
            approveAfterDays: 7,
            complianceLevel: 'CRITICAL',
            enableNonSecurity: false,
            patchFilterGroup: {
              patchFilters: [
                {
                  key: 'CLASSIFICATION',
                  values: ['Security'],
                },
                {
                  key: 'SEVERITY',
                  values: ['Critical', 'Important'],
                },
              ],
            },
          },
          {
            approveAfterDays: 7,
            enableNonSecurity: false,
            patchFilterGroup: {
              patchFilters: [
                {
                  key: 'CLASSIFICATION',
                  values: ['Bugfix'],
                }
              ],
            },
          },
        ],
      },
    });
    // 2. Maintenance Window Role
    const maintenanceWindowRole = new iam.Role(this, 'MaintenanceWindowRole', {
      roleName: `${props.project}-${props.environment}-MaintenanceWindowRole`,
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('ssm.amazonaws.com'),
        new iam.ServicePrincipal('ec2.amazonaws.com')
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonSSMMaintenanceWindowRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Add iam:PassRole permission to allow SSM to pass the role
    maintenanceWindowRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [maintenanceWindowRole.roleArn],
      conditions: {
        StringEquals: {
          'iam:PassedToService': 'ssm.amazonaws.com',
        },
      },
    }));
    // 3. Maintenance Window
    // every Sunday 3:00 UTC (12:00 JST) for a 4-hour window
    const maintenanceWindow = new ssm.CfnMaintenanceWindow(this, 'NatInstanceMaintenanceWindow', {
      name: `${props.project}-${props.environment}-NatInstancePatch`,
      description: 'Maintenance window for NAT instance patching',
      allowUnassociatedTargets: false,
      cutoff: 1, // Task execution stop time (hours)
      duration: 4, // Window length (hours)
      //schedule: 'cron(0 3 ? * SUN *)', // Every Sunday 3:00 UTC
      schedule: 'cron(15 * ? * * *)', // Every hour at minute 15 for testing
      scheduleTimezone: 'UTC',
    });
    // 4. Maintenance Window Target
    const maintenanceWindowTarget = new ssm.CfnMaintenanceWindowTarget(this, 'NatInstanceMaintenanceWindowTarget', {
      windowId: maintenanceWindow.ref,
      resourceType: 'INSTANCE',
      targets: [
        /*
        {
          key: 'InstanceIds',
          values: natInstanceIds,
        }
        */
        {
          key: 'tag:PatchGroup',
          values: [`/NatInstance/${props.project}/${props.environment}`],
        },
        {
          key: 'tag:AutoPatch',
          values: ['true'],
        }
      ],
      name: `${props.project}-${props.environment}-NatInstances`,
    });
    // 5. Maintenance Window Task (Patch)
    const logGroupName = `/${props.project}/${props.environment}/PatchManager/NatInstance`;
    // Create CloudWatch Log Group for Patch Manager output
    const natInstancePatchLogGroup = new logs.LogGroup(this, 'NatInstancePatchLogGroup', {
      logGroupName,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    natInstancePatchLogGroup.grantWrite(maintenanceWindowRole);

    const natInstancePatchTask = new ssm.CfnMaintenanceWindowTask(this, 'NatInstancePatchTask', {
      windowId: maintenanceWindow.ref,
      taskType: 'RUN_COMMAND',
      serviceRoleArn: maintenanceWindowRole.roleArn,
      taskArn: 'AWS-RunPatchBaseline', // Use simple document name
      description: 'Patch NAT instances using SSM Patch Manager',
      priority: 1,
      maxConcurrency: '1', // Execute sequentially, one instance at a time
      maxErrors: '1',
      targets: [
        {
          key: 'WindowTargetIds',
          values: [maintenanceWindowTarget.ref],
        },
      ],
      taskInvocationParameters: {
        maintenanceWindowRunCommandParameters: {
          comment: 'Apply security patches to NAT instances',
          documentVersion: '$DEFAULT',
          serviceRoleArn: maintenanceWindowRole.roleArn, // Required when notificationConfig is specified
          notificationConfig: {
            notificationArn: patchNotificationTopic.topicArn,
            notificationEvents: ['All'],
            notificationType: 'Command',
          },
          parameters: {
            Operation: ['Install'],
            RebootOption: ['RebootIfNeeded'], // Reboot if necessary
          },
          timeoutSeconds: 3600, // 1 hour timeout
          cloudWatchOutputConfig: {
            cloudWatchLogGroupName: logGroupName,
            cloudWatchOutputEnabled: true,
          },
        },
      },
    });
    natInstancePatchTask.addDependency(natInstancePatchLogGroup.node.defaultChild as cdk.CfnResource);

    // 6. Patch Compliance EventBridge Rule
    const patchComplianceRule = new events.Rule(this, 'PatchComplianceRule', {
      ruleName: `${props.project}-${props.environment}-NatInstancePatchCompliance`,
      description: 'Notify patch compliance status changes',
      eventPattern: {
        source: ['aws.ssm'],
        detailType: ['EC2 Command Status-change Notification'],
        detail: {
          'status': ['Success', 'Failed', 'TimedOut'],
          'document-name': ['AWS-RunPatchBaseline'],
        },
      },
    });

    patchComplianceRule.addTarget(new targets.SnsTopic(patchNotificationTopic, {
      message: events.RuleTargetInput.fromObject({
        default: events.EventField.fromPath('$.detail'),
        subject: `[${props.project.toUpperCase()}-${props.environment.toUpperCase()}] NAT Instance Patch Status`,
        message: {
          summary: `Patch operation ${events.EventField.fromPath('$.detail.status')}`,
          details: {
            commandId: events.EventField.fromPath('$.detail.command-id'),
            instanceId: events.EventField.fromPath('$.detail.instance-id'),
            status: events.EventField.fromPath('$.detail.status'),
            documentName: events.EventField.fromPath('$.detail.document-name'),
          },
        },
      }),
    }));
    // 7. SNS Topic Policy (Allow SSM to publish)
    patchNotificationTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowSSMPublish',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('ssm.amazonaws.com')],
      actions: ['SNS:Publish'],
      resources: [patchNotificationTopic.topicArn],
    }));

    // 8. CloudWatch Alarms for Patch Compliance
    // Detect instances with missing patches
    const complianceMetric = new cloudwatch.Metric({
      namespace: 'AWS/SSM',
      metricName: 'PatchComplianceNonCompliantCount',
      dimensionsMap: {
        PatchGroup: `/NatInstance/${props.project}/${props.environment}`,
      },
      statistic: 'Average',
      period: cdk.Duration.hours(1),
    });

    new cloudwatch.Alarm(this, 'PatchComplianceAlarm', {
      alarmName: `${props.project}-${props.environment}-NatInstancePatchNonCompliant`,
      metric: complianceMetric,
      threshold: 0,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(patchNotificationTopic));
  }

  /**
   * Create CloudWatch Alarms for NAT Instance metrics
   * @param props 
   * @param natInstanceIds 
   */
  private _createNatInstanceAlarms(props: StackProps, natInstanceIds: string[]) {
    // NAT Instance CPU Utilization Alarm
    // You can implement CloudWatch alarms for NAT instance metrics here
    natInstanceIds.forEach((instanceId, index) => {
      const cpuMetric = new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        dimensionsMap: {
          InstanceId: instanceId,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      });

      new cloudwatch.Alarm(this, `NatInstance${index + 1}CPUUtilizationAlarm`, {
        alarmName: `${props.project}-${props.environment}-NatInstance${index + 1}HighCPUUtilization`,
        metric: cpuMetric,
        threshold: 80, // 80% CPU utilization
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    });
  }

}
