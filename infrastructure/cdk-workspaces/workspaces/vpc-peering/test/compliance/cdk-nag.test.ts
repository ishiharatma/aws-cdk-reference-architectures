import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

import { VpcAStack } from "lib/stacks/vpc-a-stack";
import { VpcCStack } from 'lib/stacks/vpc-c-stack';
import { CrossAccountPeeringStack } from 'lib/stacks/cross-account-peering-stack';
import { VpcCRoutesStack } from "lib/stacks/vpc-c-routes-stack";

import { params } from "parameters/environments";
import '../parameters';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = "TestProject";
const envName: Environment = Environment.TEST;
if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

describe('CDK Nag AwsSolutions Pack', () => {
  let app: cdk.App;
  let vpcAStack: VpcAStack;
  let vpcCStack: VpcCStack;
  let crossAccountPeeringStack: CrossAccountPeeringStack;
  let vpcCRoutesStack: VpcCRoutesStack;

  beforeAll(() => {
    // Execute CDK Nag checks
    app = new cdk.App();

  vpcAStack = new VpcAStack(app, "VpcA", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
    params: envParams,
  });
  vpcCStack = new VpcCStack(app, "VpcCStack", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
    params: envParams,
  });
  crossAccountPeeringStack = new CrossAccountPeeringStack(app, "CrossAccountPeeringStack", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    params: envParams,
    terminationProtection: false,
    requestorVpc: vpcAStack.vpcB.vpc,
    requestorVpcCidr: envParams.vpcBConfig.createConfig?.cidr || '10.1.0.0/16',
    peeringVpcCidr: envParams.vpcCConfig?.createConfig?.cidr || '10.2.0.0/16',
    peeringRoleName: 'VpcPeeringAcceptRole',
  });
  vpcCRoutesStack = new VpcCRoutesStack(app, "VpcCRoutesStack", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    terminationProtection: false,
    vpc: vpcCStack.vpcC.vpc,
    vpcBCidr: vpcAStack.vpcB.vpc.vpcCidrBlock,
    params: envParams,
    peeringIdParamName: `/${projectName}/${envName}/peering/vpc-b-vpc-c/id`,
  });

    // Apply suppressions (must be applied before adding Aspects)
    applySuppressions(vpcAStack);
    applySuppressions(vpcCStack);
    applySuppressions(crossAccountPeeringStack);
    applySuppressions(vpcCRoutesStack);
    
    // Run CDK Nag
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));


  });

  describe("VpcAStack Compliance Tests", () => {
    test('No unsuppressed Warnings', () => {
      const warnings = Annotations.fromStack(vpcAStack).findWarning(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*')
      );
      // Print detailed warning information for debugging
      if (warnings.length > 0) {
        console.log('\n=== CDK Nag Warnings ===');
        warnings.forEach((warning, index) => {
          console.log(`\nWarning ${index + 1}:`);
          console.log(`  Path: ${warning.id}`);
          console.log(`  Entry:`, JSON.stringify(warning.entry, null, 2));
        });
        console.log('======================\n');
      }
      expect(warnings).toHaveLength(0);
    });

    test('No unsuppressed Errors', () => {
      const errors = Annotations.fromStack(vpcAStack).findError(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*')
      );
      // Print detailed error information for debugging
      if (errors.length > 0) {
        console.log('\n=== CDK Nag Errors ===');
        errors.forEach((error, index) => {
          console.log(`\nError ${index + 1}:`);
          console.log(`  Path: ${error.id}`);
          console.log(`  Entry:`, JSON.stringify(error.entry, null, 2));
        });
        console.log('======================\n');
      }
      expect(errors).toHaveLength(0);
    });
  });
  describe("vpcCStack Compliance Tests", () => {
    test('No unsuppressed Warnings', () => {
      const warnings = Annotations.fromStack(vpcCStack).findWarning(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*')
      );
      expect(warnings).toHaveLength(0);
    });

    test('No unsuppressed Errors', () => {
      const errors = Annotations.fromStack(vpcCStack).findError(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*')
      );
      expect(errors).toHaveLength(0);
    });
  });
  describe("crossAccountPeeringStack Compliance Tests", () => {
    test('No unsuppressed Warnings', () => {
      const warnings = Annotations.fromStack(crossAccountPeeringStack).findWarning(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*')
      );
      expect(warnings).toHaveLength(0);
    });

    test('No unsuppressed Errors', () => {
      const errors = Annotations.fromStack(crossAccountPeeringStack).findError(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*')
      );
      expect(errors).toHaveLength(0);
    });
  });
  describe("vpcCRoutesStack Compliance Tests", () => {
    test('No unsuppressed Warnings', () => {
      const warnings = Annotations.fromStack(vpcCRoutesStack).findWarning(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*')
      );
      expect(warnings).toHaveLength(0);
    });

    test('No unsuppressed Errors', () => {
      const errors = Annotations.fromStack(vpcCRoutesStack).findError(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*')
      );
      expect(errors).toHaveLength(0);
    });
  });

});

/**
 * Apply CDK Nag suppressions to the stack
 * 
 * Best Practices:
 * 1. Apply suppressions to specific resource paths whenever possible (addResourceSuppressionsByPath)
 * 2. Minimize stack-wide suppressions (addStackSuppressions)
 * 3. Use appliesTo when there are multiple specific issues with the same resource
 * 4. Provide clear and specific reasons
 */
function applySuppressionsVpcAStack(stack: VpcAStack): void {
  const stackName = stack.stackName;
  //console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);
  const pathPrefix = `/${stackName}`;

  // Apply stack-wide suppressions for example buckets that don't require logging
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-S1',
        reason: 'These are example S3 buckets for demonstration and do not require server access logging.',
      },
      {
        id: 'AwsSolutions-S10',
        reason: 'These are example S3 buckets for demonstration and SSL is not required.',
      },
      {
        id: 'AwsSolutions-VPC7',
        reason: 'VPC Flow Logs are disabled for cost optimization in this demonstration environment. Enable in production.',
      },
    ],
    true,
  );

  // Suppress validation failures for Security Groups using intrinsic functions
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/VpcABPeering/PeerVpcPeeringSecurityGroup/Resource`,
    [
      {
        id: 'CdkNagValidationFailure',
        reason: 'Security Group uses intrinsic functions (Fn::GetAtt, Fn::Join) for dynamic CIDR blocks and descriptions, which cannot be validated at synthesis time. This is expected behavior for cross-VPC peering.',
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/VpcABPeering/LocalVpcPeeringSecurityGroup/Resource`,
    [
      {
        id: 'CdkNagValidationFailure',
        reason: 'Security Group uses intrinsic functions (Fn::GetAtt, Fn::Join) for dynamic CIDR blocks and descriptions, which cannot be validated at synthesis time. This is expected behavior for cross-VPC peering.',
      },
    ],
  );

  // Suppress validation failures for test instance security groups using intrinsic functions
  const securityGroupPaths = [
    `${pathPrefix}/VpcATestInstance/SecurityGroup/Resource`,
    `${pathPrefix}/VpcBTestInstance/SecurityGroup/Resource`,
  ];
  securityGroupPaths.forEach(path => {
    NagSuppressions.addResourceSuppressionsByPath(
      stack,
      path,
      [
        {
          id: 'CdkNagValidationFailure',
          reason: 'Security Group uses intrinsic functions (Fn::GetAtt) for VPC CIDR blocks which cannot be validated at synthesis time. This is expected for imported VPCs.',
        },
      ],
    );
  });

  // Suppress test instance warnings (these are for demonstration purposes)
  const testInstancePaths = [
    `${pathPrefix}/VpcATestInstance/Resource/InstanceRole/Resource`,
    `${pathPrefix}/VpcBTestInstance/Resource/InstanceRole/Resource`,
  ];
  testInstancePaths.forEach(path => {
    NagSuppressions.addResourceSuppressionsByPath(
      stack,
      path,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Test instances use AWS managed policy (AmazonSSMManagedInstanceCore) for demonstration purposes. In production, use custom managed policies.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore'],
        },
      ],
    );
  });

  // Suppress Custom Resource Lambda function IAM and runtime warnings
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource`,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS Custom Resource framework uses AWS managed policy (AWSLambdaBasicExecutionRole) for Lambda execution. This is CDK-generated infrastructure.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
    [
      {
        id: 'AwsSolutions-L1',
        reason: 'AWS Custom Resource framework controls the Lambda runtime version. This is CDK-generated infrastructure and will be updated by CDK.',
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/VpcABPeering/EnableVpcPeeringDnsResolution/CustomResourcePolicy/Resource`,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Custom Resource requires wildcard permissions to modify VPC peering connection options. This is necessary for the DNS resolution feature.',
        appliesTo: ['Resource::*'],
      },
    ],
  );

  const ec2TestInstancePaths = [
    `${pathPrefix}/VpcATestInstance/Resource/Resource`,
    `${pathPrefix}/VpcBTestInstance/Resource/Resource`,
  ];
  ec2TestInstancePaths.forEach(path => {
    NagSuppressions.addResourceSuppressionsByPath(
      stack,
      path,
      [
        {
          id: 'AwsSolutions-EC28',
          reason: 'Test EC2 instances do not require detailed monitoring for demonstration purposes. Enable in production for better insights.',
        },
        {
          id: 'AwsSolutions-EC29',
          reason: 'Test EC2 instances do not require termination protection for demonstration purposes. Enable in production environments.',
        },
      ],
    );
  });
}

function applySuppressionsVpcCStack(stack: VpcCStack): void {
  const stackName = stack.stackName;
  //console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);
  const pathPrefix = `/${stackName}`;

  // Apply stack-wide suppressions for example buckets that don't require logging
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-S1',
        reason: 'These are example S3 buckets for demonstration and do not require server access logging.',
      },
      {
        id: 'AwsSolutions-S10',
        reason: 'These are example S3 buckets for demonstration and SSL is not required.',
      },
      {
        id: 'AwsSolutions-VPC7',
        reason: 'VPC Flow Logs are disabled for cost optimization in this demonstration environment. Enable in production.',
      },
    ],
    true,
  );

  // Suppress validation failure for test instance security group
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/TestInstance/SecurityGroup/Resource`,
    [
      {
        id: 'CdkNagValidationFailure',
        reason: 'Security Group uses intrinsic functions (Fn::GetAtt) for VPC CIDR blocks which cannot be validated at synthesis time. This is expected for imported VPCs.',
      },
    ],
  );

  // Suppress test instance warnings (these are for demonstration purposes)
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/TestInstance/Resource/InstanceRole/Resource`,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Test instance uses AWS managed policy (AmazonSSMManagedInstanceCore) for demonstration purposes. In production, use custom managed policies.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore'],
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/TestInstance/Resource/Resource`,
    [
      {
        id: 'AwsSolutions-EC28',
        reason: 'Test EC2 instance does not require detailed monitoring for demonstration purposes. Enable in production for better insights.',
      },
      {
        id: 'AwsSolutions-EC29',
        reason: 'Test EC2 instance does not require termination protection for demonstration purposes. Enable in production environments.',
      },
    ],
  );
}

function applySuppressionsCrossAccountPeeringStack(stack: CrossAccountPeeringStack): void {
  const stackName = stack.stackName;
  //console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);
  const pathPrefix = `/${stackName}`;

  // Apply stack-wide suppressions for example buckets that don't require logging
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-S1',
        reason: 'These are example S3 buckets for demonstration and do not require server access logging.',
      },
      {
        id: 'AwsSolutions-S10',
        reason: 'These are example S3 buckets for demonstration and SSL is not required.',
      },
    ],
    true,
  );

  // Suppress Custom Resource Lambda function IAM and runtime warnings
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource`,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS Custom Resource framework uses AWS managed policy (AWSLambdaBasicExecutionRole) for Lambda execution. This is CDK-generated infrastructure.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
    [
      {
        id: 'AwsSolutions-L1',
        reason: 'AWS Custom Resource framework controls the Lambda runtime version. This is CDK-generated infrastructure and will be updated by CDK.',
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/EnableVpcPeeringDnsResolution/CustomResourcePolicy/Resource`,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Custom Resource requires wildcard permissions to modify VPC peering connection options. This is necessary for the DNS resolution feature.',
        appliesTo: ['Resource::*'],
      },
    ],
  );
}

function applySuppressionsVpcCRoutesStack(stack: VpcCRoutesStack): void {
  const stackName = stack.stackName;
  //console.log(`Applying CDK Nag suppressions to stack: ${stackName}`);
  const pathPrefix = `/${stackName}`;

  // Apply stack-wide suppressions for example buckets that don't require logging
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-S1',
        reason: 'These are example S3 buckets for demonstration and do not require server access logging.',
      },
      {
        id: 'AwsSolutions-S10',
        reason: 'These are example S3 buckets for demonstration and SSL is not required.',
      },
    ],
    true,
  );

  // Suppress Custom Resource Lambda function IAM and runtime warnings
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource`,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS Custom Resource framework uses AWS managed policy (AWSLambdaBasicExecutionRole) for Lambda execution. This is CDK-generated infrastructure.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
    [
      {
        id: 'AwsSolutions-L1',
        reason: 'AWS Custom Resource framework controls the Lambda runtime version. This is CDK-generated infrastructure and will be updated by CDK.',
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${pathPrefix}/EnableVpcPeeringDnsResolution/CustomResourcePolicy/Resource`,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Custom Resource requires wildcard permissions to modify VPC peering connection options. This is necessary for the DNS resolution feature.',
        appliesTo: ['Resource::*'],
      },
    ],
  );
}

function applySuppressions(stack: cdk.Stack): void {
  if (stack instanceof VpcAStack) {
    applySuppressionsVpcAStack(stack);
  } else if (stack instanceof VpcCStack) {
    applySuppressionsVpcCStack(stack);
  } else if (stack instanceof CrossAccountPeeringStack) {
    applySuppressionsCrossAccountPeeringStack(stack);
  } else if (stack instanceof VpcCRoutesStack) {
    applySuppressionsVpcCRoutesStack(stack);
  } else {
    console.warn(`No suppression function defined for stack: ${stack.stackName}`);
  }
}