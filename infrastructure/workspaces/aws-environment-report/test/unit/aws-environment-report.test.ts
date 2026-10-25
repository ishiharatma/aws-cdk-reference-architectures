import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { loadCdkContext } from '@common/test-helpers/test-context';
import { AwsEnvironmentReportDataStack } from 'lib/stacks/aws-environment-report-data-stack';
import { AwsEnvironmentReportApplicationStack } from 'lib/stacks/aws-environment-report-application-stack';
import { validateParams } from 'lib/helpers/validate-params';
import { EnvParams, params } from 'parameters/environments';
import { DEFAULT_WEBHOOK_SECRET } from 'src/lambda/common/webhook-config';
import 'test/parameters';

const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const baseContext = loadCdkContext(path.resolve(__dirname, '../../cdk.json'));

function synth(p: EnvParams = envParams) {
  const app = new cdk.App({ context: baseContext });
  const common = {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    params: p,
  };
  const data = new AwsEnvironmentReportDataStack(app, 'Data', common);
  const application = new AwsEnvironmentReportApplicationStack(app, 'Application', {
    ...common,
    bucket: data.bucket,
    key: data.key,
    webhookSecret: data.webhookSecret,
  });
  return { data: Template.fromStack(data), application: Template.fromStack(application) };
}

describe('validateParams', () => {
  const withRegions = (regions: string[]): EnvParams => ({ ...envParams, target: { regions } });

  test('accepts the test parameters', () => {
    expect(() => validateParams(envParams)).not.toThrow();
  });

  test('rejects a region list without us-east-1', () => {
    expect(() => validateParams(withRegions(['ap-northeast-1']))).toThrow(/us-east-1/);
  });

  test('rejects invalid, duplicate and empty region lists', () => {
    expect(() => validateParams(withRegions(['us-east-1', 'tokyo']))).toThrow(/invalid region/);
    expect(() => validateParams(withRegions(['us-east-1', 'us-east-1']))).toThrow(/duplicates/);
    expect(() => validateParams(withRegions([]))).toThrow(/empty/);
  });

  test('rejects a deadline day outside 1-28 and a slash-wrapped CUR prefix', () => {
    expect(() =>
      validateParams({ ...envParams, schedule: { ...envParams.schedule, finalizeDeadlineDay: 31 } })
    ).toThrow(/finalizeDeadlineDay/);
    const cur = { bucketName: 'b', exportName: 'e', prefix: '/cur/' };
    expect(() => validateParams({ ...envParams, cur })).toThrow(/prefix/);
  });
});

describe('AwsEnvironmentReportDataStack', () => {
  const { data } = synth();

  test('creates a KMS-encrypted, versioned, non-public bucket with a raw/ expiry', () => {
    data.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
          }),
        ],
      },
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'raw/', ExpirationInDays: 90, Status: 'Enabled' }),
        ]),
      },
    });
  });

  test('creates the webhook secret with the placeholder default value', () => {
    data.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${projectName}-${envName}-environment-report-webhooks`,
      SecretString: DEFAULT_WEBHOOK_SECRET,
    });
  });
});

describe('AwsEnvironmentReportApplicationStack', () => {
  const { application } = synth();

  test('creates six Node.js functions and one container-image function', () => {
    application.resourcePropertiesCountIs('AWS::Lambda::Function', { Runtime: 'nodejs22.x' }, 6);
    application.resourcePropertiesCountIs('AWS::Lambda::Function', { PackageType: 'Image' }, 1);
  });

  test('passes the target regions and time zone to the collectors', () => {
    application.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `${projectName}-${envName}-envreport-collect-config`,
      Environment: {
        Variables: Match.objectLike({
          TARGET_REGIONS: 'us-east-1,ap-northeast-1',
          TIME_ZONE: 'Asia/Tokyo',
        }),
      },
    });
  });

  test('grants the collectors read-only API actions only', () => {
    const policies = application.findResources('AWS::IAM::Policy');
    const actions = Object.values(policies)
      .flatMap(
        (p) =>
          (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } })
            .Properties.PolicyDocument.Statement
      )
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .filter((a) =>
        /^(config|securityhub|guardduty|access-analyzer|inspector2|resource-explorer-2):/.test(a)
      );
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toMatch(/:(Describe|Get|List|Select|BatchGet|Search$)/);
    }
  });

  test('grants Search for Resource Explorer ListResources', () => {
    application.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['resource-explorer-2:Search']),
          }),
        ]),
      }),
    });
  });

  test('limits CUR bucket access to the export prefix', () => {
    application.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:ListBucket',
            Condition: { StringLike: { 's3:prefix': ['cur/cur2/*'] } },
          }),
        ]),
      }),
    });
  });

  test('creates a Standard state machine and a daily schedule in the month-start window', () => {
    application.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: `${projectName}-${envName}-environment-report`,
      StateMachineType: 'STANDARD',
    });
    application.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 9 3-10 * ? *)',
      ScheduleExpressionTimezone: 'Asia/Tokyo',
    });
  });

  test('catches every collector failure inside the Parallel state', () => {
    const machines = application.findResources('AWS::StepFunctions::StateMachine');
    const definition = JSON.stringify(Object.values(machines)[0]);
    for (const name of ['config', 'resource-explorer', 'cost', 'security']) {
      expect(definition).toContain(`Collect ${name} failed`);
    }
  });

  test('omits CUR permissions when cur is not configured', () => {
    const { application: noCur } = synth({ ...envParams, cur: undefined });
    const json = JSON.stringify(noCur.toJSON());
    expect(json).not.toContain('test-cur-bucket');
  });
});
