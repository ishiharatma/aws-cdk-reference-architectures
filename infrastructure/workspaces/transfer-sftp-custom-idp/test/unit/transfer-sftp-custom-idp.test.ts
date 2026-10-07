import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { TransferSftpCustomIdpStack } from 'lib/stacks/transfer-sftp-custom-idp-stack';
import { EnvParams, params } from 'parameters/environments';
import '../parameters';

const envParams = params[Environment.TEST] as EnvParams;

function build(overrides: Partial<typeof envParams> = {}): Template {
  const app = new cdk.App();
  const stack = new TransferSftpCustomIdpStack(app, 'TestSftp', {
    project: 'test',
    environment: Environment.TEST,
    env: { account: '123456789012', region: 'ap-northeast-1' },
    isAutoDeleteObject: true,
    envParams: { ...envParams, ...overrides },
  });
  return Template.fromStack(stack);
}

describe('Transfer Family server', () => {
  const template = build();

  test('PUBLIC endpoint, SFTP only, Lambda IdP, public key only', () => {
    template.hasResourceProperties('AWS::Transfer::Server', {
      EndpointType: 'PUBLIC',
      Protocols: ['SFTP'],
      Domain: 'S3',
      IdentityProviderType: 'AWS_LAMBDA',
      IdentityProviderDetails: { SftpAuthenticationMethods: 'PUBLIC_KEY' },
      SecurityPolicyName: envParams.securityPolicyName,
    });
  });

  test('no VPC endpoint / security group / service managed user', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
    template.resourceCountIs('AWS::Transfer::User', 0);
  });

  test('structured logs go to an encrypted log group', () => {
    template.hasResourceProperties('AWS::Transfer::Server', {
      StructuredLogDestinations: Match.anyValue(),
      LoggingRole: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', { KmsKeyId: Match.anyValue(), RetentionInDays: 30 });
  });
});

describe('Custom IdP Lambda', () => {
  const template = build();

  test('function config has no credentials and points at the table', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.14',
      Handler: 'handler.lambda_handler',
      Environment: { Variables: { USER_TABLE_NAME: Match.anyValue(), IDENTITY_PROVIDER_KEY: 'publickeys', LOG_LEVEL: 'INFO' } },
    });
  });

  test('Lambda may only GetItem on the user table', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'dynamodb:GetItem', Effect: 'Allow' }),
        ]),
      },
    });
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain('dynamodb:PutItem"],"Effect":"Allow","Resource":{"Fn::GetAtt":["UserTable');
  });

  test('Transfer Family may invoke the function, scoped to the server', () => {
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'transfer.amazonaws.com',
      SourceArn: Match.anyValue(),
    });
  });
});

describe('Data stores', () => {
  const template = build();

  test('user table: composite key, on-demand, SSE, PITR', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'user', KeyType: 'HASH' },
        { AttributeName: 'identity_provider_key', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      SSESpecification: { SSEEnabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  test('bucket blocks public access and enforces TLS', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        ]),
      },
    });
  });

  test('log encryption can be disabled by parameter', () => {
    const t = build({ enableLogEncryption: false });
    // only the alert topic key remains
    t.resourceCountIs('AWS::KMS::Key', 1);
    expect(JSON.stringify(t.findResources('AWS::Logs::LogGroup'))).not.toContain('KmsKeyId');
  });
});

describe('IAM', () => {
  const template = build();

  test('access role trusts Transfer Family with account/server conditions', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'transfer.amazonaws.com' },
            Condition: Match.objectLike({ StringEquals: Match.objectLike({ 'aws:SourceAccount': Match.anyValue() }) }),
          }),
        ]),
      },
    });
  });

  test('admin policy is limited to the user table', () => {
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:PutItem', 'dynamodb:DeleteItem']),
            Resource: Match.objectLike({ 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('^UserTable')]) }),
          }),
        ],
      },
    });
  });
});

describe('Server run modes', () => {
  const lifecycle = (l: Partial<EnvParams['serverLifecycle']>): Partial<EnvParams> => ({
    serverLifecycle: { mode: 'always', ...l },
  });

  test('always: the server is a CloudFormation resource and no controller exists', () => {
    const t = build(lifecycle({ mode: 'always' }));
    t.resourceCountIs('AWS::Transfer::Server', 1);
    t.resourceCountIs('AWS::Scheduler::Schedule', 0);
    t.resourceCountIs('Custom::SftpServerCleanup', 0);
  });

  test('manual: no CloudFormation server, controller and cleanup resource', () => {
    const t = build(lifecycle({ mode: 'manual' }));
    t.resourceCountIs('AWS::Transfer::Server', 0);
    t.resourceCountIs('AWS::Scheduler::Schedule', 0);
    t.resourceCountIs('Custom::SftpServerCleanup', 1);
    t.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'handler.lambda_handler',
      Environment: { Variables: Match.objectLike({ SECURITY_POLICY_NAME: envParams.securityPolicyName }) },
    });
  });

  test('manual: the IdP permission covers servers of the account and the role trusts user ARNs', () => {
    const t = build(lifecycle({ mode: 'manual' }));
    const json = JSON.stringify(t.toJSON());
    expect(json).toContain(':server/*');
    expect(json).toContain(':user/*');
    expect(json).not.toContain('AWS::Transfer::Server');
  });

  test('manual: the controller may only delete servers tagged for this stack', () => {
    const t = build(lifecycle({ mode: 'manual' }));
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['transfer:DeleteServer', 'transfer:DescribeServer'],
            Condition: { StringEquals: { 'aws:ResourceTag/sftp-custom-idp-stack': Match.anyValue() } },
          }),
        ]),
      },
    });
  });

  test('manual: admin policy can invoke the controller', () => {
    const t = build(lifecycle({ mode: 'manual' }));
    t.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: 'lambda:InvokeFunction' })]),
      },
    });
  });

  test('scheduled: start and stop schedules call the controller with the given expressions', () => {
    const t = build(lifecycle({
      mode: 'scheduled',
      startExpression: 'cron(0 8 ? * MON-FRI *)',
      stopExpression: 'cron(0 20 ? * MON-FRI *)',
      timezone: 'Asia/Tokyo',
    }));
    t.resourceCountIs('AWS::Scheduler::Schedule', 2);
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 8 ? * MON-FRI *)',
      ScheduleExpressionTimezone: 'Asia/Tokyo',
      Target: Match.objectLike({ Input: '{"action":"start"}' }),
    });
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 20 ? * MON-FRI *)',
      Target: Match.objectLike({ Input: '{"action":"stop"}' }),
    });
  });

  test('scheduled: expressions are required', () => {
    expect(() => build(lifecycle({ mode: 'scheduled' }))).toThrow(/startExpression/);
  });

  test('host key secret is passed to the controller and readable by it', () => {
    const arn = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:sftp-host-key-AbCdEf';
    const t = build(lifecycle({ mode: 'manual', hostKeySecretArn: arn }));
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ HOST_KEY_SECRET_ARN: arn }) },
    });
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: 'secretsmanager:GetSecretValue', Resource: arn })]),
      },
    });
  });
});

describe('Monitoring', () => {
  test('log based alarms for auth failures, IP denials and IdP errors publish to an encrypted topic', () => {
    const t = build();
    t.hasResourceProperties('AWS::Logs::MetricFilter', { FilterPattern: '"AUTH_FAILURE"' });
    t.hasResourceProperties('AWS::Logs::MetricFilter', { FilterPattern: '"ip_not_allowed"' });
    t.hasResourceProperties('AWS::Logs::MetricFilter', { FilterPattern: '?"dynamodb_error" ?"unexpected_error"' });
    t.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: Match.anyValue() });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'test-test-sftp-AuthFailure',
      Threshold: envParams.monitoring.authFailureThreshold,
      AlarmActions: [Match.anyValue()],
    });
  });

  test('always: BytesIn / BytesOut alarms are CloudFormation resources on the server', () => {
    const t = build();
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'test-test-sftp-BytesIn',
      Namespace: 'AWS/Transfer',
      MetricName: 'BytesIn',
      Threshold: envParams.monitoring.bytesInThresholdMb * 1024 * 1024,
      Dimensions: [{ Name: 'ServerId', Value: Match.anyValue() }],
    });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'BytesOut' });
  });

  test('manual: server alarms are owned by the controller, not by CloudFormation', () => {
    const t = build({ serverLifecycle: { mode: 'manual' } });
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toContain('"MetricName":"BytesIn"');
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'test-test-sftp-ServerControllerError', MetricName: 'Errors' });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ ALARM_PREFIX: 'test-test-sftp', ALARM_PERIOD_MINUTES: '5' }) },
    });
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: ['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms'] }),
        ]),
      },
    });
  });

  test('alert emails become subscriptions', () => {
    const t = build({ monitoring: { ...envParams.monitoring, alertEmails: ['ops@example.com'] } });
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
  });

  test('monitoring can be disabled', () => {
    const t = build({ monitoring: { ...envParams.monitoring, enabled: false } });
    t.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    t.resourceCountIs('AWS::SNS::Topic', 0);
  });
});
