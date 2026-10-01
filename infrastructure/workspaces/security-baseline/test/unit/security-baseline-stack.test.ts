/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { MANAGED_RULES } from 'lib/constructs/config-construct';
import { SecurityBaselineStack } from 'lib/stacks/security-baseline-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const build = (overrides: Partial<typeof envParams> = {}, isAutoDeleteObject = true) => {
  const app = new cdk.App();
  const stack = new SecurityBaselineStack(app, 'SecurityBaseline', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject,
    env: testEnv,
    params: { ...envParams, ...overrides },
  });
  return Template.fromStack(stack);
};

describe('SecurityBaselineStack', () => {
  const template = build();

  describe('log archive', () => {
    test('one private, versioned, TLS-only bucket with a lifecycle expiration', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: { Status: 'Enabled' },
        LifecycleConfiguration: {
          Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 365, Status: 'Enabled' })]),
        },
      });
      template.resourceCountIs('AWS::S3::Bucket', 1);
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        },
      });
    });

    test('the CloudTrail key has rotation enabled', () => {
      template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    });

    test('non-production keeps nothing behind: bucket and key are deleted with the stack', () => {
      template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
      template.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Delete' });
    });

    test('production retains the bucket and key', () => {
      const prod = build({}, false);
      prod.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
      prod.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
    });
  });

  describe('CloudTrail', () => {
    test('a multi-Region trail with global events, log file validation and KMS', () => {
      template.resourceCountIs('AWS::CloudTrail::Trail', 1);
      template.hasResourceProperties('AWS::CloudTrail::Trail', {
        TrailName: 'test-test-secbase-trail',
        IsLogging: true,
        IsMultiRegionTrail: true,
        IncludeGlobalServiceEvents: true,
        EnableLogFileValidation: true,
        S3KeyPrefix: 'cloudtrail',
        KMSKeyId: Match.anyValue(),
        CloudWatchLogsLogGroupArn: Match.anyValue(),
      });
    });

    test('the trail log group uses the configured retention', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 });
    });

    test('the key policy lets CloudTrail encrypt log files and describe the key', () => {
      template.hasResourceProperties('AWS::KMS::Key', {
        KeyPolicy: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AllowCloudTrailToEncryptLogs',
              Principal: { Service: 'cloudtrail.amazonaws.com' },
              Action: 'kms:GenerateDataKey*',
              Condition: { StringLike: { 'kms:EncryptionContext:aws:cloudtrail:arn': Match.anyValue() } },
            }),
            Match.objectLike({
              Sid: 'AllowCloudTrailToDescribeKey',
              Principal: { Service: 'cloudtrail.amazonaws.com' },
              Action: 'kms:DescribeKey',
            }),
          ]),
        },
      });
    });
  });

  describe('AWS Config', () => {
    // The recorder, delivery channel and start-recording call are AwsCustomResource direct SDK calls
    // (Custom::Config*), not the native CfnConfigurationRecorder/CfnDeliveryChannel resources: see the
    // comment in ConfigConstruct for why the native resources can never stabilize.
    test('the recorder is created for all supported resource types, including global ones', () => {
      template.resourceCountIs('Custom::ConfigConfigurationRecorder', 1);
      // The role ARN is a CFN intrinsic, so the Create payload is an Fn::Join of string fragments
      // rather than a single literal JSON string; match the fragments instead of the whole document.
      template.hasResourceProperties('Custom::ConfigConfigurationRecorder', {
        Create: {
          'Fn::Join': [
            '',
            Match.arrayWith([
              Match.stringLikeRegexp(
                '"service":"ConfigService","action":"putConfigurationRecorder".*"name":"test-test-secbase-recorder"'
              ),
              Match.stringLikeRegexp('"allSupported":true,"includeGlobalResourceTypes":true'),
            ]),
          ],
        },
      });
    });

    test('the recorder role trusts Config and uses the AWS managed Config policy', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [Match.objectLike({ Principal: { Service: 'config.amazonaws.com' } })],
        },
        ManagedPolicyArns: [
          Match.objectLike({
            'Fn::Join': [
              '',
              Match.arrayWith([Match.stringLikeRegexp('service-role/AWS_ConfigRole')]),
            ],
          }),
        ],
      });
    });

    test('the delivery channel writes to the archive under the config prefix', () => {
      template.resourceCountIs('Custom::ConfigDeliveryChannel', 1);
      // The bucket name is a CFN intrinsic, so the Create payload is an Fn::Join of string fragments
      // rather than a single literal JSON string; match the fragments instead of the whole document.
      template.hasResourceProperties('Custom::ConfigDeliveryChannel', {
        Create: {
          'Fn::Join': [
            '',
            Match.arrayWith([
              Match.stringLikeRegexp(
                '"service":"ConfigService","action":"putDeliveryChannel".*"name":"test-test-secbase-channel"'
              ),
            ]),
          ],
        },
      });
      template.hasResourceProperties('Custom::ConfigDeliveryChannel', {
        Create: {
          'Fn::Join': [
            '',
            Match.arrayWith([
              Match.stringLikeRegexp(
                '"s3KeyPrefix":"config","configSnapshotDeliveryProperties":\\{"deliveryFrequency":"TwentyFour_Hours"\\}'
              ),
            ]),
          ],
        },
      });
    });

    test('recording is started once the recorder and channel exist', () => {
      template.resourceCountIs('Custom::ConfigStartRecording', 1);
      template.hasResourceProperties('Custom::ConfigStartRecording', {
        Create: Match.serializedJson(
          Match.objectLike({
            service: 'ConfigService',
            action: 'startConfigurationRecorder',
            parameters: { ConfigurationRecorderName: 'test-test-secbase-recorder' },
          })
        ),
      });
    });

    test("the bucket policy lets only this account's Config deliver, with bucket-owner-full-control", () => {
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AWSConfigBucketPermissionsCheck',
              Action: ['s3:GetBucketAcl', 's3:ListBucket'],
            }),
            Match.objectLike({
              Sid: 'AWSConfigBucketDelivery',
              Action: 's3:PutObject',
              Principal: { Service: 'config.amazonaws.com' },
              Condition: {
                StringEquals: {
                  'aws:SourceAccount': '123456789012',
                  's3:x-amz-acl': 'bucket-owner-full-control',
                },
              },
            }),
          ]),
        },
      });
    });

    test('every managed rule is created, one per identifier', () => {
      template.resourceCountIs('AWS::Config::ConfigRule', MANAGED_RULES.length);
      MANAGED_RULES.forEach((identifier) => {
        template.hasResourceProperties('AWS::Config::ConfigRule', {
          Source: { Owner: 'AWS', SourceIdentifier: identifier },
        });
      });
    });

    test('ACCESS_KEYS_ROTATED has its required maxAccessKeyAge parameter', () => {
      // AWS Config rejects this rule's creation outright ("required parameter [maxAccessKeyAge] is
      // not present") without it; every other managed rule here needs no input parameters.
      template.hasResourceProperties('AWS::Config::ConfigRule', {
        Source: { SourceIdentifier: 'ACCESS_KEYS_ROTATED' },
        InputParameters: { maxAccessKeyAge: '90' },
      });
    });

    test('recorder, channel, start-recording and the managed rules are created in that order', () => {
      const dependsOn = (r: any): string[] => [r.DependsOn ?? []].flat();
      const recorderId = Object.keys(
        template.findResources('Custom::ConfigConfigurationRecorder')
      )[0];
      const channelId = Object.keys(template.findResources('Custom::ConfigDeliveryChannel'))[0];
      const startId = Object.keys(template.findResources('Custom::ConfigStartRecording'))[0];

      const channel = template.findResources('Custom::ConfigDeliveryChannel')[channelId];
      expect(dependsOn(channel)).toContain(recorderId);

      const start = template.findResources('Custom::ConfigStartRecording')[startId];
      expect(dependsOn(start)).toContain(channelId);

      Object.values(template.findResources('AWS::Config::ConfigRule')).forEach((rule: any) => {
        expect(dependsOn(rule)).toContain(startId);
      });
    });
  });

  describe('GuardDuty', () => {
    test('one enabled detector with the protection plans from parameters', () => {
      template.resourceCountIs('AWS::GuardDuty::Detector', 1);
      template.hasResourceProperties('AWS::GuardDuty::Detector', {
        Enable: true,
        FindingPublishingFrequency: 'FIFTEEN_MINUTES',
        Features: [
          { Name: 'S3_DATA_EVENTS', Status: 'ENABLED' },
          { Name: 'EBS_MALWARE_PROTECTION', Status: 'ENABLED' },
          { Name: 'RDS_LOGIN_EVENTS', Status: 'ENABLED' },
          { Name: 'LAMBDA_NETWORK_LOGS', Status: 'ENABLED' },
        ],
      });
    });

    test('a protection plan switched off in parameters is emitted as DISABLED, not omitted', () => {
      const t = build({
        guardDuty: {
          ...envParams.guardDuty,
          ebsMalwareProtection: false,
          lambdaNetworkLogs: false,
        },
      });
      t.hasResourceProperties('AWS::GuardDuty::Detector', {
        Features: [
          { Name: 'S3_DATA_EVENTS', Status: 'ENABLED' },
          { Name: 'EBS_MALWARE_PROTECTION', Status: 'DISABLED' },
          { Name: 'RDS_LOGIN_EVENTS', Status: 'ENABLED' },
          { Name: 'LAMBDA_NETWORK_LOGS', Status: 'DISABLED' },
        ],
      });
    });
  });

  describe('IAM Access Analyzer', () => {
    test('an account-scoped external-access analyzer is always created', () => {
      template.hasResourceProperties('AWS::AccessAnalyzer::Analyzer', {
        AnalyzerName: 'test-test-secbase-external-access',
        Type: 'ACCOUNT',
      });
    });

    test('the unused-access analyzer uses the configured age when enabled', () => {
      template.hasResourceProperties('AWS::AccessAnalyzer::Analyzer', {
        Type: 'ACCOUNT_UNUSED_ACCESS',
        AnalyzerConfiguration: { UnusedAccessConfiguration: { UnusedAccessAge: 90 } },
      });
    });

    test('the unused-access analyzer is not created when disabled (it is billed)', () => {
      const t = build({ enableUnusedAccessAnalyzer: false });
      t.resourceCountIs('AWS::AccessAnalyzer::Analyzer', 1);
    });
  });

  describe('Security Hub', () => {
    test('one hub with default standards off and security-control findings', () => {
      template.resourceCountIs('AWS::SecurityHub::Hub', 1);
      template.hasResourceProperties('AWS::SecurityHub::Hub', {
        EnableDefaultStandards: false,
        ControlFindingGenerator: 'SECURITY_CONTROL',
        AutoEnableControls: true,
      });
    });

    test('subscribes to AWS Foundational Security Best Practices in this Region, and only that by default', () => {
      template.resourceCountIs('AWS::SecurityHub::Standard', 1);
      template.hasResourceProperties('AWS::SecurityHub::Standard', {
        StandardsArn: {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              ':securityhub:ap-northeast-1::standards/aws-foundational-security-best-practices/v/1.0.0',
            ],
          ],
        },
      });
    });

    test('additional standards from parameters are subscribed too', () => {
      const extra = 'arn:aws:securityhub:::ruleset/example/v/1.0.0';
      const t = build({ additionalSecurityHubStandardArns: [extra] });
      t.resourceCountIs('AWS::SecurityHub::Standard', 2);
      t.hasResourceProperties('AWS::SecurityHub::Standard', { StandardsArn: extra });
    });

    test('the hub is created after Config has started recording, GuardDuty and Access Analyzer', () => {
      const hub: any = Object.values(template.findResources('AWS::SecurityHub::Hub'))[0];
      const deps: string[] = [hub.DependsOn ?? []].flat();
      [
        'Custom::ConfigStartRecording',
        'AWS::GuardDuty::Detector',
        'AWS::AccessAnalyzer::Analyzer',
      ].forEach((type) => {
        const ids = Object.keys(template.findResources(type));
        expect(ids.some((id) => deps.includes(id))).toBe(true);
      });
    });
  });

  describe('findings notification', () => {
    test('a rule matches new, active, high-severity Security Hub findings', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'test-test-secbase-findings',
        State: 'ENABLED',
        EventPattern: {
          source: ['aws.securityhub'],
          'detail-type': ['Security Hub Findings - Imported'],
          detail: {
            findings: {
              Severity: { Label: ['CRITICAL', 'HIGH'] },
              Workflow: { Status: ['NEW'] },
              RecordState: ['ACTIVE'],
            },
          },
        },
      });
    });

    test('the severities come from parameters', () => {
      const t = build({ notification: { severities: ['CRITICAL'], emails: [] } });
      t.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({
          detail: { findings: Match.objectLike({ Severity: { Label: ['CRITICAL'] } }) },
        }),
      });
    });

    test('the topic is encrypted with the CMK, and TLS is required', () => {
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'test-test-secbase-findings',
        KmsMasterKeyId: Match.anyValue(),
      });
      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        },
      });
    });

    test('the key policy lets EventBridge use the key, for this account only', () => {
      template.hasResourceProperties('AWS::KMS::Key', {
        KeyPolicy: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AllowEventBridgeToUseKeyForFindingsTopic',
              Principal: { Service: 'events.amazonaws.com' },
              Action: ['kms:Decrypt', 'kms:GenerateDataKey*'],
              Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
            }),
          ]),
        },
      });
    });

    test('the target publishes to the topic with bounded retries and a DLQ', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'test-test-secbase-findings',
        Targets: [
          Match.objectLike({
            RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 3 },
            DeadLetterConfig: { Arn: Match.anyValue() },
            InputTransformer: Match.anyValue(),
          }),
        ],
      });
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'test-test-secbase-findings-dlq',
        SqsManagedSseEnabled: true,
        MessageRetentionPeriod: 14 * 24 * 60 * 60,
      });
    });

    test('the message is a readable text template with the finding fields', () => {
      const rule: any = Object.values(template.findResources('AWS::Events::Rule')).find(
        (r: any) => r.Properties.Name === 'test-test-secbase-findings'
      );
      const paths = JSON.stringify(rule.Properties.Targets[0].InputTransformer.InputPathsMap);
      [
        'Severity.Label',
        'Title',
        'AwsAccountId',
        'Region',
        'ProductName',
        'Resources[0].Id',
        'Id',
      ].forEach((f) => {
        expect(paths).toContain(`$.detail.findings[0].${f}`);
      });
    });

    test('each configured email is subscribed, and none when the list is empty', () => {
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'security@example.com',
      });
      build({ notification: { severities: ['HIGH'], emails: [] } }).resourceCountIs(
        'AWS::SNS::Subscription',
        0
      );
    });
  });

  describe('outputs', () => {
    test('exposes the archive bucket, trail, detector, hub and topic', () => {
      [
        'LogArchiveBucketName',
        'TrailArn',
        'GuardDutyDetectorId',
        'SecurityHubArn',
        'FindingsTopicArn',
      ].forEach((name) => {
        expect(template.toJSON().Outputs).toHaveProperty(name);
      });
    });
  });
});
