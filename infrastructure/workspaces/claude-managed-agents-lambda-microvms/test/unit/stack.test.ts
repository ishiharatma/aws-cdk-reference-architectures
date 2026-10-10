import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildStack } from '../helpers';
import '../parameters';

/** The ARN embeds the partition pseudo parameter, so it renders as an Fn::Join ending in the connector name. */
const connectorArn = (name: string) =>
  Match.objectLike({ 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp(`:${name}$`)])] });

describe('default stack (internet egress, all ingress)', () => {
  const template = Template.fromStack(buildStack());

  test('MicroVM image enables every lifecycle hook on port 9000', () => {
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      Hooks: {
        Port: 9000,
        MicrovmImageHooks: Match.objectLike({ Ready: 'ENABLED', Validate: 'ENABLED' }),
        MicrovmHooks: Match.objectLike({ Run: 'ENABLED', Suspend: 'ENABLED', Resume: 'ENABLED', Terminate: 'ENABLED' }),
      },
    });
  });

  test('no VPC resources are created', () => {
    template.resourceCountIs('AWS::EC2::VPC', 0);
    template.resourceCountIs('AWS::NetworkFirewall::Firewall', 0);
    template.resourceCountIs('AWS::Lambda::NetworkConnector', 0);
  });

  test('launcher passes the AWS-managed connectors and a bounded lifetime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          INGRESS_CONNECTOR_ARN: connectorArn('ALL_INGRESS'),
          EGRESS_CONNECTOR_ARN: connectorArn('INTERNET_EGRESS'),
          MAX_LIFETIME_SECONDS: '14400',
          IDLE_POLICY: JSON.stringify({ maxIdleDurationSeconds: 600, suspendedDurationSeconds: 0, autoResumeEnabled: false }),
        }),
      },
    });
  });

  test('launcher never receives the environment key, only its parameter name', () => {
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { Environment: { Variables: { ENVIRONMENT_KEY_PARAM_NAME: Match.anyValue() } } },
    });
    const env = Object.values(functions)[0].Properties.Environment.Variables;
    expect(env.ENVIRONMENT_KEY_PARAM_NAME).toBe('/test/test/anthropic/environment-key');
    expect(JSON.stringify(env)).not.toMatch(/sk-ant|ANTHROPIC_API_KEY/);
  });

  test('secrets are split by reader: launcher the signing secret, MicroVM the environment key', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const statementsOf = (needle: string) => policies
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter((s: { Action: string | string[]; Resource: unknown }) =>
        JSON.stringify(s.Resource).includes(needle) && JSON.stringify(s.Action).includes('ssm:GetParameter'));
    const signing = statementsOf('webhook-signing-secret');
    const envKey = statementsOf('environment-key');
    expect(signing).toHaveLength(1);
    expect(envKey).toHaveLength(1);

    const policyFor = (needle: string) => policies.find((p) =>
      JSON.stringify(p.Properties.PolicyDocument).includes(needle));
    expect(JSON.stringify(policyFor('webhook-signing-secret')?.Properties.Roles)).toContain('Launcher');
    expect(JSON.stringify(policyFor('environment-key')?.Properties.Roles)).toContain('MicrovmExecutionRole');
  });

  test('kms:Decrypt is bounded to SSM and to the single parameter', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'kms:Decrypt',
            Condition: { StringEquals: Match.objectLike({ 'kms:ViaService': 'ssm.ap-northeast-1.amazonaws.com' }) },
          }),
        ]),
      },
    });
  });

  test('execution role can terminate its own MicroVM', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'lambda:TerminateMicrovm' })]) },
    });
  });

  test('launcher can run MicroVMs and pass the role and network connectors', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'lambda:RunMicrovm' }),
          Match.objectLike({ Action: 'iam:PassRole' }),
          Match.objectLike({ Action: 'lambda:PassNetworkConnector' }),
        ]),
      },
    });
  });

  test('image build waits for the build role policies', () => {
    const image = Object.values(template.findResources('AWS::Lambda::MicrovmImage'))[0];
    expect(JSON.stringify(image.DependsOn)).toContain('MicrovmImageBuildRole');
  });

  test('webhook API validates the body and has the WAF attached', () => {
    template.hasResourceProperties('AWS::ApiGateway::RequestValidator', { ValidateRequestBody: true });
    template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'POST', AuthorizationType: 'NONE' });
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Rules: Match.arrayWith([Match.objectLike({ Name: 'RateLimitPerIp', Action: { Block: {} } })]),
    });
  });

  test('idempotency table expires items with TTL and uses the Powertools-compatible key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'expiration', Enabled: true },
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('alarms cover launcher errors, 401s, RunMicrovm failures, capacity and stale MicroVMs', () => {
    ['LauncherErrors', 'WebhookRejected', 'RunMicrovmFailed', 'RunMicrovmCapacity', 'StaleMicrovms'].forEach((name) => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: `test-test-claude-${name}` });
    });
    template.resourceCountIs('AWS::Logs::MetricFilter', 3);
  });

  test('stale detector runs every 10 minutes', () => {
    template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(10 minutes)' });
  });

  test('monthly budget notifies at 80% and 100%', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 100, Unit: 'USD' }, TimeUnit: 'MONTHLY' }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({ Notification: Match.objectLike({ Threshold: 80 }) }),
        Match.objectLike({ Notification: Match.objectLike({ Threshold: 100 }) }),
      ]),
    });
  });

  test('no customer managed key for the secrets by default', () => {
    template.resourceCountIs('AWS::KMS::Alias', 0);
  });
});

describe('firewall egress and no ingress', () => {
  const template = Template.fromStack(buildStack({
    network: { egressMode: 'firewall', ingressMode: 'none', allowedDomains: ['api.anthropic.com', '.amazonaws.com'], vpcCidr: '10.60.0.0/24' },
  }));

  test('VPC egress connector for MicroVMs in the workload subnet', () => {
    template.hasResourceProperties('AWS::Lambda::NetworkConnector', {
      Configuration: { VpcEgressConfiguration: Match.objectLike({ AssociatedComputeResourceTypes: ['MicroVm'], NetworkProtocol: 'IPv4' }) },
    });
  });

  test('firewall allows only the configured domains over HTTP host and TLS SNI', () => {
    template.hasResourceProperties('AWS::NetworkFirewall::RuleGroup', {
      RuleGroup: Match.objectLike({
        RulesSource: {
          RulesSourceList: { GeneratedRulesType: 'ALLOWLIST', TargetTypes: ['HTTP_HOST', 'TLS_SNI'], Targets: ['api.anthropic.com', '.amazonaws.com'] },
        },
      }),
    });
  });

  test('workload route table sends the default route to the firewall, firewall to NAT', () => {
    template.resourceCountIs('AWS::NetworkFirewall::Firewall', 1);
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    const routes = Object.values(template.findResources('AWS::EC2::Route')).map((r) => r.Properties);
    expect(routes.filter((r) => r.VpcEndpointId && r.DestinationCidrBlock === '0.0.0.0/0')).toHaveLength(1);
    expect(routes.filter((r) => r.NatGatewayId && r.DestinationCidrBlock === '0.0.0.0/0')).toHaveLength(1);
    // The return route targets the workload subnet CIDR; the VPC CIDR is already covered by the local route.
    const returnRoutes = routes.filter((r) => r.VpcEndpointId && r.DestinationCidrBlock !== '0.0.0.0/0');
    expect(returnRoutes).toHaveLength(1);
    expect(returnRoutes[0].DestinationCidrBlock).not.toBe('10.60.0.0/24');
  });

  test('connector security group only allows HTTPS out and nothing in', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Outbound HTTPS only for Claude worker MicroVMs',
      SecurityGroupEgress: [Match.objectLike({ FromPort: 443, ToPort: 443, IpProtocol: 'tcp' })],
    });
  });

  test('launcher uses NO_INGRESS and the VPC connector', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          INGRESS_CONNECTOR_ARN: connectorArn('NO_INGRESS'),
          EGRESS_CONNECTOR_ARN: Match.objectLike({ 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('Connector'), 'Arn']) }),
        }),
      },
    });
  });

  test('firewall logs go to CloudWatch Logs', () => {
    template.hasResourceProperties('AWS::NetworkFirewall::LoggingConfiguration', Match.anyValue());
  });
});

describe('customer managed key', () => {
  const template = Template.fromStack(buildStack({ secrets: { useCustomerManagedKey: true } }));

  test('creates a rotating key with an alias for the SecureStrings', () => {
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    template.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/test-test-claude-secrets' });
  });

  test('kms:Decrypt targets the key ARN instead of a wildcard', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter((s: { Action: string; Condition?: unknown }) => s.Action === 'kms:Decrypt' && JSON.stringify(s.Condition).includes('PARAMETER_ARN'));
    expect(statements.length).toBeGreaterThanOrEqual(2);
    statements.forEach((s: { Resource: unknown }) => expect(s.Resource).not.toBe('*'));
  });
});

describe('optional operations settings', () => {
  test('without alarmEmail there is no subscription and no budget', () => {
    const template = Template.fromStack(buildStack({ operations: { monthlyBudgetUsd: 100 } }));
    template.resourceCountIs('AWS::SNS::Subscription', 0);
    template.resourceCountIs('AWS::Budgets::Budget', 0);
  });

  test('idle policy and lifetime are taken from the parameters', () => {
    const template = Template.fromStack(buildStack({
      microvm: {
        baseImageArn: 'arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1',
        baseImageVersion: '1',
        maxLifetimeSeconds: 7200,
        idlePolicy: { maxIdleDurationSeconds: 1800, suspendedDurationSeconds: 60, autoResumeEnabled: true },
      },
    }));
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          MAX_LIFETIME_SECONDS: '7200',
          IDLE_POLICY: JSON.stringify({ maxIdleDurationSeconds: 1800, suspendedDurationSeconds: 60, autoResumeEnabled: true }),
        }),
      },
    });
  });
});
