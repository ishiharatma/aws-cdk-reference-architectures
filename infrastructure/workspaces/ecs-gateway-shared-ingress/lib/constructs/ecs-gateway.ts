import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { GatewayAccessType, GatewayParams, TestTrafficHeader } from 'parameters/environments';

/** Properties for {@link EcsGateway}. */
export interface EcsGatewayProps {
  /** Account-unique gateway name (immutable). */
  readonly gatewayName: string;
  /** `internet-facing` gives access type PUBLIC, `internal` gives PRIVATE (immutable). */
  readonly scheme: 'internet-facing' | 'internal';
  /** Subnets of the gateway-managed ALBs. They decide which VPC and AZs the gateway can serve (immutable). */
  readonly subnets: ec2.ISubnet[];
  /** Role ECS assumes to create the ALBs, listener rules, target groups, security groups and certificates. */
  readonly infrastructureRole: iam.IRole;
  readonly gateway: GatewayParams;
  /** Own inbound security group. When set, ECS stops managing the inbound rules of the ALBs. */
  readonly inboundSecurityGroup?: ec2.ISecurityGroup;
  /** Regional Web ACL attached to every ALB the gateway creates. */
  readonly webAclArn?: string;
  /** ALB access log destination. The bucket policy must let Elastic Load Balancing write to it. */
  readonly accessLogs?: { readonly bucket: s3.IBucket; readonly prefix: string };
  /** Header that sends requests to the new revision during progressive deployments. */
  readonly testTrafficHeader?: TestTrafficHeader;
}

/**
 * Amazon ECS Gateway (`AWS::ECS::Gateway`, HostSharedAlb type).
 *
 * aws-cdk-lib has no L1 class for this resource yet, so it is written with `CfnResource`.
 * Creating the gateway provisions nothing; ECS creates the first ALB when the first service connects.
 */
export class EcsGateway extends Construct {
  readonly resource: cdk.CfnResource;
  readonly gatewayArn: string;
  readonly gatewayName: string;
  readonly accessType: GatewayAccessType;

  constructor(scope: Construct, id: string, props: EcsGatewayProps) {
    super(scope, id);

    const hostSharedAlb: Record<string, unknown> = {
      Scheme: props.scheme,
      MaxAlbCount: props.gateway.maxAlbCount,
      HttpDesync: props.gateway.httpDesync,
      NetworkConfiguration: {
        Subnets: props.subnets.map((subnet) => subnet.subnetId),
        IpAddressType: props.gateway.ipAddressType,
        InboundSecurityGroup: props.inboundSecurityGroup?.securityGroupId,
      },
      WebACLArn: props.webAclArn,
      AccessLogs: props.accessLogs && {
        Destination: { S3: { Bucket: props.accessLogs.bucket.bucketName, Prefix: props.accessLogs.prefix } },
      },
      TestTrafficRules: props.testTrafficHeader && {
        Header: { Name: props.testTrafficHeader.name, Values: props.testTrafficHeader.values },
      },
    };

    this.resource = new cdk.CfnResource(this, 'Resource', {
      type: 'AWS::ECS::Gateway',
      properties: {
        GatewayName: props.gatewayName,
        InfrastructureRoleArn: props.infrastructureRole.roleArn,
        // Deletion protection defaults to true and is propagated to the managed ALBs.
        DeletionProtection: props.gateway.deletionProtection,
        // GATEWAY would also copy the aws:cloudformation:* tags CloudFormation puts on the gateway, and
        // ACM rejects those (RequestCertificate: InvalidTagException), leaving routes in CREATE_IN_PROGRESS.
        PropagateTags: 'NONE',
        Configuration: { HostSharedAlb: hostSharedAlb },
      },
    });
    // ECS validates that it can assume the role (and its policy) when the gateway is created.
    this.resource.node.addDependency(props.infrastructureRole);

    acknowledgeUnknownType(this.resource);

    this.gatewayArn = this.resource.getAtt('Arn').toString();
    this.gatewayName = props.gatewayName;
    this.accessType = props.scheme === 'internet-facing' ? 'PUBLIC' : 'PRIVATE';
  }

  /**
   * Associates the gateway with a cluster (`AWS::ECS::GatewayClusterAssociations`).
   * Services in the cluster opt in with a gateway connector; the association alone routes nothing.
   */
  associateWith(id: string, cluster: ecs.ICluster): cdk.CfnResource {
    const association = new cdk.CfnResource(this, id, {
      type: 'AWS::ECS::GatewayClusterAssociations',
      properties: { Gateway: this.gatewayArn, Cluster: cluster.clusterArn },
    });
    acknowledgeUnknownType(association);
    return association;
  }
}

/** The bundled cfn-lint schema does not know the gateway resource types yet; CloudFormation accepts them. */
function acknowledgeUnknownType(resource: cdk.CfnResource): void {
  cdk.Validations.of(resource).acknowledge({
    id: 'CloudFormation-Validate::F3006',
    reason: 'cfn-lint schema predates AWS::ECS::Gateway / GatewayClusterAssociations; CloudFormation accepts them.',
  });
}
