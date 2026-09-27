import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { loadCdkContext } from '@common/test-helpers/test-context';
import { AwsEolMonitorDataStack } from 'lib/stacks/aws-eol-monitor-data-stack';
import { AwsEolMonitorApplicationStack } from 'lib/stacks/aws-eol-monitor-application-stack';
import { params } from 'parameters/environments';
import 'test/parameters';

const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const baseContext = loadCdkContext(path.resolve(__dirname, '../../cdk.json'));

describe('AwsEolMonitorDataStack Fine-grained Assertions', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: baseContext });
    const stack = new AwsEolMonitorDataStack(app, 'Data', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      terminationProtection: false,
    });
    template = Template.fromStack(stack);
  });

  test('creates a single DynamoDB table with PITR enabled and the expected key schema', () => {
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: `${projectName}-${envName}-eol-state`,
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: 'serviceCode', KeyType: 'HASH' }),
        Match.objectLike({ AttributeName: 'version', KeyType: 'RANGE' }),
      ]),
    });
  });
});

describe('AwsEolMonitorApplicationStack Fine-grained Assertions', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: baseContext });
    const dataStack = new AwsEolMonitorDataStack(app, 'Data', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      terminationProtection: false,
    });
    const stack = new AwsEolMonitorApplicationStack(app, 'Application', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      terminationProtection: false,
      params: envParams,
      table: dataStack.table,
    });
    template = Template.fromStack(stack);
  });

  test('creates two Lambda functions (fetch-diff, generate-report)', () => {
    template.resourceCountIs('AWS::Lambda::Function', 2);
  });

  test('creates an SNS topic with an email subscription', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: `${projectName}-${envName}-eol-report`,
    });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'test@example.com',
    });
  });

  test('creates a Standard Step Functions state machine', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: `${projectName}-${envName}-eol-monitor`,
      StateMachineType: 'STANDARD',
    });
  });

  test('creates an EventBridge Scheduler schedule targeting the state machine', () => {
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: `${projectName}-${envName}-eol-check`,
      ScheduleExpression: 'cron(0 9 * * ? *)',
    });
  });

  test('grants the generate-report function Bedrock InvokeModel', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'bedrock:InvokeModel', Effect: 'Allow' }),
        ]),
      }),
    });
  });
});
