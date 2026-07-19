import * as cr from 'aws-cdk-lib/custom-resources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct, IDependable } from 'constructs';

export interface CloudFrontVpcOriginsServiceSecurityGroupProps {
    /** The VPC that the VPC origin (and the AWS-managed service SG) was created in */
    readonly vpc: ec2.IVpc;
    /**
     * Resource(s) that must be created before this lookup runs — typically the VPC origin
     * itself (e.g. the `cloudfront.CfnVpcOrigin` behind `VpcOrigin.withApplicationLoadBalancer`).
     * The AWS-managed service SG only exists once at least one VPC origin has been created in
     * this VPC, so this dependency is required for a fresh deployment to succeed.
     */
    readonly dependsOn: IDependable | IDependable[];
}

/**
 * Looks up the AWS-managed "CloudFront-VPCOrigins-Service-SG" security group that CloudFront
 * auto-creates in a VPC after the first VPC origin is created there, and returns it as an
 * `ec2.IPeer` usable in a security group ingress rule.
 *
 * `ec2.SecurityGroup.fromLookupByName` can't be used for this: it resolves at `cdk synth` time
 * (before any deployment), so it can't depend on a resource created earlier in the same
 * deployment. This uses a deploy-time `AwsCustomResource` instead, ordered via `dependsOn` —
 * the CDK equivalent of a Terraform data source with `depends_on`.
 *
 * Only use this once the VPC origin already exists in the target VPC (e.g. from a prior deploy).
 * On a fresh VPC with no VPC origin yet, prefer `ec2.Peer.ipv4(vpc.vpcCidrBlock)` or the
 * CloudFront managed prefix list (`com.amazonaws.<region>.cloudfront.origin-facing`) instead.
 */
export function lookupCloudFrontVpcOriginsServiceSecurityGroup(
  scope: Construct,
  id: string,
  props: CloudFrontVpcOriginsServiceSecurityGroupProps
): ec2.IPeer {
  const lookup = new cr.AwsCustomResource(scope, id, {
    onUpdate: {
      service: 'EC2',
      action: 'describeSecurityGroups',
      parameters: {
        Filters: [
          { Name: 'group-name', Values: ['CloudFront-VPCOrigins-Service-SG'] },
          { Name: 'vpc-id', Values: [props.vpc.vpcId] },
        ],
      },
      physicalResourceId: cr.PhysicalResourceId.of(`${id}-CloudFrontVpcOriginsServiceSG`),
    },
    policy: cr.AwsCustomResourcePolicy.fromStatements([
      // DescribeSecurityGroups does not support resource-level permissions
      new iam.PolicyStatement({
        actions: ['ec2:DescribeSecurityGroups'],
        resources: ['*'],
      }),
    ]),
  });

  const deps = Array.isArray(props.dependsOn) ? props.dependsOn : [props.dependsOn];
  deps.forEach((dep) => lookup.node.addDependency(dep));

  return ec2.Peer.securityGroupId(lookup.getResponseField('SecurityGroups.0.GroupId'));
}
