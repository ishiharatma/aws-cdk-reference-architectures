import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildStack, newApp, testParams } from '../helpers/stack';

describe('LambdaManagedInstancesGpuStack', () => {
  const template = Template.fromStack(buildStack());

  describe('GPU capacity provider', () => {
    test('allows only the configured G-series types on x86_64', () => {
      template.resourceCountIs('AWS::Lambda::CapacityProvider', 1);
      template.hasResourceProperties('AWS::Lambda::CapacityProvider', {
        InstanceRequirements: {
          Architectures: ['x86_64'],
          AllowedInstanceTypes: ['g6.2xlarge', 'g5.2xlarge', 'g4dn.2xlarge'],
        },
      });
    });

    test('caps vCPUs below the L2 minimum of 12 through the escape hatch', () => {
      template.hasResourceProperties('AWS::Lambda::CapacityProvider', {
        CapacityProviderScalingConfig: { MaxVCpuCount: 8, ScalingMode: 'Auto' },
      });
    });

    test('launches instances in isolated subnets with the instance security group', () => {
      template.hasResourceProperties('AWS::Lambda::CapacityProvider', {
        VpcConfig: {
          SubnetIds: Match.arrayWith([{ Ref: Match.stringLikeRegexp('VpcIsolatedSubnet1') }]),
          SecurityGroupIds: [{ 'Fn::GetAtt': [Match.stringLikeRegexp('InstanceSecurityGroup'), 'GroupId'] }],
        },
      });
    });

    test('operator role trusts Lambda and uses the AWS managed operator policy', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [Match.objectLike({ Principal: { Service: 'lambda.amazonaws.com' } })],
        },
        ManagedPolicyArns: [
          { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AWSLambdaManagedEC2ResourceOperator']] },
        ],
      });
    });

    test('propagates project tags to the managed EC2 resources', () => {
      template.hasResourceProperties('AWS::Lambda::CapacityProvider', {
        PropagateTags: {
          Mode: 'Explicit',
          ExplicitTags: Match.arrayWith([{ Key: 'Project', Value: 'test' }]),
        },
      });
    });

    test('switches to a Manual GPU utilization policy when a target is set', () => {
      const t = Template.fromStack(
        buildStack(newApp(), { capacity: { ...testParams().capacity, targetGpuUtilization: 60 } }),
      );
      t.hasResourceProperties('AWS::Lambda::CapacityProvider', {
        CapacityProviderScalingConfig: {
          MaxVCpuCount: 8,
          ScalingMode: 'Manual',
          ScalingPolicies: [{ PredefinedMetricType: 'LambdaCapacityProviderAverageGPUUtilization', TargetValue: 60 }],
        },
      });
    });
  });

  describe('GPU inference function', () => {
    const findInferenceFunction = (): Record<string, unknown> => {
      const fns = template.findResources('AWS::Lambda::Function', {
        Properties: { PackageType: 'Image' },
      });
      expect(Object.keys(fns)).toHaveLength(1);
      return Object.values(fns)[0].Properties as Record<string, unknown>;
    };

    test('is a container image function on x86_64', () => {
      const props = findInferenceFunction();
      expect(props.Architectures).toEqual(['x86_64']);
      expect(props.MemorySize).toBe(8192);
      expect(props.Timeout).toBe(60);
    });

    test('requests a GPU through AcceleratorConfig', () => {
      expect(findInferenceFunction().AcceleratorConfig).toEqual({ AcceleratorMemorySize: 16 });
    });

    test('is attached to the capacity provider with per-environment concurrency', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        PackageType: 'Image',
        CapacityProviderConfig: {
          LambdaManagedInstancesCapacityProviderConfig: {
            CapacityProviderArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('GpuCapacityProvider'), 'Arn'] },
            PerExecutionEnvironmentMaxConcurrency: 4,
            ExecutionEnvironmentMemoryGiBPerVCpu: 2,
          },
        },
      });
    });

    test('publishes $LATEST.PUBLISHED with the configured scaling bounds', () => {
      const props = findInferenceFunction();
      expect(props.PublishToLatestPublished).toBe(true);
      expect(props.FunctionScalingConfig).toEqual({ MinExecutionEnvironments: 1, MaxExecutionEnvironments: 1 });
    });

    test('receives the result table name', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        PackageType: 'Image',
        Environment: { Variables: { TABLE_NAME: { Ref: Match.stringLikeRegexp('ResultTable') }, RESULT_TTL_DAYS: '7' } },
      });
    });
  });

  describe('event pipeline', () => {
    test('S3 notifies the queue for objects under input/', () => {
      template.hasResourceProperties('Custom::S3BucketNotifications', {
        NotificationConfiguration: {
          QueueConfigurations: [
            Match.objectLike({
              Events: ['s3:ObjectCreated:*'],
              Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'input/' }] } },
            }),
          ],
        },
      });
    });

    test('event source mapping batches messages and reports partial failures', () => {
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        BatchSize: 8,
        MaximumBatchingWindowInSeconds: 5,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
      });
    });

    test('queue visibility timeout is six times the function timeout and redrives to a DLQ', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        VisibilityTimeout: 360,
        RedrivePolicy: { maxReceiveCount: 5, deadLetterTargetArn: Match.anyValue() },
        SqsManagedSseEnabled: true,
      });
    });

    test('result table uses on-demand billing, PITR and TTL', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: [{ AttributeName: 'objectKey', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      });
    });

    test('function may read only the input/ prefix', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['s3:GetObject*']),
              Resource: Match.arrayWith([
                { 'Fn::Join': ['', [{ 'Fn::GetAtt': [Match.stringLikeRegexp('ImageBucket'), 'Arn'] }, '/input/*']] },
              ]),
            }),
          ]),
        },
      });
    });
  });

  describe('network', () => {
    test('has no NAT gateway or internet gateway', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      template.resourceCountIs('AWS::EC2::InternetGateway', 0);
    });

    test('provides S3 / DynamoDB gateway endpoints and a CloudWatch Logs interface endpoint', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        VpcEndpointType: 'Gateway',
        ServiceName: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['.s3'])] }),
      });
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        VpcEndpointType: 'Gateway',
        ServiceName: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['.dynamodb'])] }),
      });
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        VpcEndpointType: 'Interface',
        ServiceName: 'com.amazonaws.ap-northeast-1.logs',
        PrivateDnsEnabled: true,
      });
    });

    test('spreads isolated subnets across the configured AZs', () => {
      template.resourceCountIs('AWS::EC2::Subnet', testParams().maxAzs);
    });
  });

  describe('observability', () => {
    test('alarms when messages reach the dead-letter queue', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
      });
    });

    test('dashboard charts capacity provider GPU metrics', () => {
      const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
      const body = JSON.stringify(Object.values(dashboards)[0].Properties);
      expect(body).toContain('GPUUtilization');
      expect(body).toContain('GPUAllocated');
      expect(body).toContain('CapacityProviderName');
    });
  });
});
