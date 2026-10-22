import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { buildStack } from '../helpers/stack';

describe('CDK Nag AwsSolutions Pack', () => {
  test('stack has no unsuppressed findings', () => {
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = buildStack(app);
    applySuppressions(stack);
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    app.synth();

    const warnings = Annotations.fromStack(stack).findWarning(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    );
    const errors = Annotations.fromStack(stack).findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    );
    const findings = [...warnings, ...errors];
    if (findings.length > 0) {
      console.log(
        JSON.stringify(
          findings.map((f) => ({ id: f.id, entry: f.entry.data })),
          null,
          2
        )
      );
    }
    expect(findings).toHaveLength(0);
  });
});

/**
 * Each suppression is either a managed policy the durable functions documentation names,
 * a resource pattern the durable execution ARN format requires, or a scope cut documented
 * in the README. Suppressions use `appliesTo` so any new, unrelated finding still fails.
 */
function applySuppressions(stack: cdk.Stack): void {
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicDurableExecutionRolePolicy is the AWS managed policy the Lambda docs name for durable functions ' +
          '(CloudWatch Logs + lambda:CheckpointDurableExecution / GetDurableExecutionState); CDK attaches it when durableConfig is set.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy',
        ],
      },
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'CloudWatch Logs permissions for the three API handler functions; scoped by Lambda to their own log groups.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Account-level API Gateway CloudWatch role required for execution logging (APIG6).',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Callback APIs are authorized against the durable execution ARN <function-arn>:<version>/durable-execution/..., ' +
          'so the documented resource is <function-arn>:*. It is limited to this one function and to SendDurableExecutionCallbackSuccess.',
        appliesTo: ['Resource::<WorkflowFunction9B932173.Arn>:*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'kms:GenerateDataKey* is added by topic.grantPublish for the topic CMK; the resource is that single key.',
        appliesTo: ['Action::kms:GenerateDataKey*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'table.grants.readData covers the status GSI (<table-arn>/index/*); the table has only that one index.',
        appliesTo: ['Resource::<RequestsTable419243C7.Arn>/index/*'],
      },
      {
        id: 'AwsSolutions-COG4',
        reason:
          'The API uses IAM (SigV4) authorization for workforce/service callers instead of a Cognito user pool (see README).',
      },
      {
        id: 'AwsSolutions-APIG3',
        reason:
          'IAM authorization rejects unsigned requests and the stage is throttled; add a regional WAF web ACL for public exposure.',
      },
    ],
    true
  );

  // ---- Demo web UI (demoWebUi.enabled) --------------------------------------------------
  const stage = '<RequestsApiDeploymentStagetestA4D5B1C1>';
  const apiArn = `arn:<AWS::Partition>:execute-api:ap-northeast-1:123456789012:<RequestsApi5EAF7131>/${stage}`;
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    [
      '/LambdaDurableFunctionsApproval/DemoWebUi/RequesterRole/DefaultPolicy/Resource',
      '/LambdaDurableFunctionsApproval/DemoWebUi/ApproverRole/DefaultPolicy/Resource',
    ],
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'execute-api ARNs need a wildcard for the {requestId} path parameter; each statement names one method and path shape.',
        appliesTo: [
          `Resource::${apiArn}/GET/requests/*`,
          `Resource::${apiArn}/POST/requests/*/decision`,
        ],
      },
    ]
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    '/LambdaDurableFunctionsApproval/DemoWebUi/UserPool/Resource',
    [
      {
        id: 'AwsSolutions-COG2',
        reason:
          'Demo users are created by an administrator with generated passwords and only reach a demo API; enable MFA before real use.',
      },
      {
        id: 'AwsSolutions-COG8',
        reason:
          'Essentials plan (managed login). Threat protection of the Plus plan is a per-MAU cost the demo does not need.',
      },
    ]
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    '/LambdaDurableFunctionsApproval/DemoWebUi/WebBucket/Resource',
    [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Private bucket read only by CloudFront (OAC) and holding four public static files; no access log bucket for a demo.',
      },
    ]
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    '/LambdaDurableFunctionsApproval/DemoWebUi/Distribution/Resource',
    [
      { id: 'AwsSolutions-CFR1', reason: 'Demo UI; no geography-based restriction is required.' },
      {
        id: 'AwsSolutions-CFR2',
        reason:
          'Static files only; the API behind it is IAM-authorized and throttled. Add a CloudFront WAF web ACL for public use.',
      },
      {
        id: 'AwsSolutions-CFR3',
        reason: 'Demo UI; standard logging adds a log bucket and is left out.',
      },
      {
        id: 'AwsSolutions-CFR4',
        reason:
          'Uses the default *.cloudfront.net certificate, whose security policy cannot be raised; use a custom domain + ACM certificate with TLSv1.2_2021 in production.',
      },
    ]
  );
  // BucketDeployment's singleton function and role are generated by aws-cdk-lib.
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    [
      '/LambdaDurableFunctionsApproval/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C256MiB/Resource',
      '/LambdaDurableFunctionsApproval/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C256MiB/ServiceRole/DefaultPolicy/Resource',
    ],
    [
      {
        id: 'AwsSolutions-L1',
        reason: 'Runtime of the aws-cdk-lib BucketDeployment handler is managed by aws-cdk-lib.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Generated by BucketDeployment: read the CDK asset bucket, write the web bucket, and create CloudFront invalidations (no resource-level permission).',
        appliesTo: [
          'Action::s3:GetObject*',
          'Action::s3:GetBucket*',
          'Action::s3:List*',
          'Action::s3:DeleteObject*',
          'Action::s3:Abort*',
          'Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-123456789012-ap-northeast-1/*',
          'Resource::<DemoWebUiWebBucket8FFDB3E2.Arn>/*',
          'Resource::*',
        ],
      },
    ]
  );
}
