import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { VpcConfig, Environment } from 'lib/types';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { pascalCase } from 'change-case-commonjs';

export interface StackProps extends cdk.StackProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
  vpcConfig: VpcConfig;
}

export class CdkTSParametersStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Create VPC based on provided parameters
    if (props.vpcConfig.existingVpcId) {
      this.vpc = ec2.Vpc.fromLookup(this, 'VPC', {
        vpcId: props.vpcConfig.existingVpcId,
      });
      return;
    }

    if (props.vpcConfig.createConfig) {
      const createConfig = props.vpcConfig.createConfig;
      const vpcNameSuffix = createConfig['vpcName'] ?? 'vpc';  
      this.vpc = new ec2.Vpc(this, 'VPC', {
            vpcName: `${pascalCase(props.project)}/${pascalCase(props.environment)}/${pascalCase(vpcNameSuffix)}`,
        ipAddresses: ec2.IpAddresses.cidr(createConfig.cidr),
        maxAzs: createConfig.maxAzs || cdk.Stack.of(this).availabilityZones.length,
        natGateways: createConfig.natCount || 1,
        subnetConfiguration: createConfig.subnets ||
        [
          // Default subnet configuration if none provided
          {
              subnetType: ec2.SubnetType.PUBLIC,
              name: 'Public',
              cidrMask: 24,
          },
          {
              subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
              name: 'Private',
              cidrMask: 24,
          },
        ],
        enableDnsHostnames: createConfig.enableDnsHostnames || true,
        enableDnsSupport: createConfig.enableDnsSupport || true,
      });
    } else {
      throw new Error('VPC configuration is required to create the VPC.');
    }

  }
}
