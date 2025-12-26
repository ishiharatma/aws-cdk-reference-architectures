import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Environment } from 'lib/types';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { pascalCase } from 'change-case-commonjs';

export interface StackProps extends cdk.StackProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
}

export class CdkJsonParametersStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const params = this.node.tryGetContext(props.environment) || {};
    const vpcConfig = params['vpcConfig'] || {};

    if (vpcConfig['existingVpcId']) {
      this.vpc = ec2.Vpc.fromLookup(this, "VPC", {
        vpcId: vpcConfig['existingVpcId'],
      });
      return;
    }

    if (!vpcConfig['createConfig']) {
      throw new Error('VPC createConfig is required in JSON parameters to create the VPC.');
    }
    const createConfig = vpcConfig['createConfig'];
    const subnets = createConfig['subnets'] || [
      {
        subnetType: 'PUBLIC',
        name: 'Public',
        cidrMask: 24,
      },
      {
          subnetType: 'PRIVATE_WITH_EGRESS',
          name: 'Private',
          cidrMask: 24,
      }
    ];
    // Create VPC based on JSON parameters
    const vpcNameSuffix = createConfig['vpcName'] ?? 'vpc';  
    this.vpc = new ec2.Vpc(this, "VPC", {
      vpcName: `${pascalCase(props.project)}/${pascalCase(props.environment)}/${pascalCase(vpcNameSuffix)}`,
      ipAddresses: ec2.IpAddresses.cidr(createConfig['cidr'] || '10.1.0.0/16'),
      maxAzs: createConfig['maxAzs'] || 3, // maximum number of AZs to use
      // You can explicitly set availabilityZones here if you need to pin the VPC to specific AZs.
      natGateways: createConfig['natCount'] || 1, // number of NAT Gateways
      subnetConfiguration: 
        subnets.map((subnet: any) => {
          if (subnet['subnetType'] === 'PUBLIC') {
            return {
              subnetType: ec2.SubnetType.PUBLIC,
              name: subnet['name'] || 'Public',
              cidrMask: subnet['cidrMask'] || 24,
            };
          } else if (subnet['subnetType'] === 'PRIVATE_WITH_NAT') {
            return {
              subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
              name: subnet['name'] || 'Private',
              cidrMask: subnet['cidrMask'] || 24,
            };
          }
          return null;
        }).filter((config: any) => config !== null),
    });

  }
}
