import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagPackSuppression, NagSuppressions } from 'cdk-nag';
import { buildStage, newApp } from '../helpers/stage';

const lambdaBasicExecution: NagPackSuppression = {
  id: 'AwsSolutions-IAM4',
  reason: "AWSLambdaBasicExecutionRole only grants writing the function's own CloudWatch Logs.",
  appliesTo: [
    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
  ],
};

describe('CDK Nag AwsSolutions Pack', () => {
  const app = newApp();
  const stage = buildStage({ app });
  const stacks: cdk.Stack[] = [stage.network, stage.directory, stage.workspaces, stage.usageReport];

  // ---------------------------------------------------------------- Directory
  NagSuppressions.addResourceSuppressions(stage.directory.managementInstance.instance, [
    {
      id: 'AwsSolutions-EC28',
      reason:
        'Basic monitoring is enough for a single management instance used for AD administration.',
    },
    {
      id: 'AwsSolutions-EC29',
      reason:
        'The management instance is stateless (AD objects live in Managed AD) and is rebuilt by the bootstrap association.',
    },
  ]);
  NagSuppressions.addResourceSuppressions(
    stage.directory.managementInstance,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AmazonSSMManagedInstanceCore is the AWS-maintained minimum for Run Command / Session Manager; no inbound port is opened.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore'],
      },
    ],
    true
  );
  NagSuppressions.addResourceSuppressions(stage.directory.managedAd.adminSecret, [
    {
      id: 'AwsSolutions-SMG4',
      reason:
        'The Managed AD Admin password cannot be rotated by Secrets Manager without a custom rotation that calls ' +
        'ResetUserPassword; it is a break-glass credential read only by the management instance.',
    },
  ]);
  NagSuppressions.addStackSuppressions(stage.directory, [lambdaBasicExecution]);

  // ---------------------------------------------------------------- WorkSpaces
  NagSuppressions.addResourceSuppressions(
    stage.workspaces.directory,
    [
      lambdaBasicExecution,
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'workspaces_DefaultRole must carry AmazonWorkSpacesServiceAccess / AmazonWorkSpacesSelfServiceAccess as documented by WorkSpaces.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonWorkSpacesServiceAccess',
          'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonWorkSpacesSelfServiceAccess',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'RegisterWorkspaceDirectory / Modify* / DescribeWorkspaceDirectories and the EC2 / DS calls WorkSpaces makes during ' +
          'registration do not support resource-level permissions.',
        appliesTo: ['Resource::*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'CDK Provider framework: invoke permission on specific function versions (<arn>:*).',
        appliesTo: [{ regex: '/^Resource::<WorkSpacesDirectory.+\\.Arn>:\\*$/g' }],
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'CDK Provider framework functions use the runtime pinned by aws-cdk-lib.',
      },
      {
        id: 'AwsSolutions-SF1',
        reason: 'CDK Provider framework waiter state machine; handler logs are in CloudWatch Logs.',
      },
      {
        id: 'AwsSolutions-SF2',
        reason:
          'CDK Provider framework waiter state machine; X-Ray adds nothing to a polling loop.',
      },
    ],
    true
  );
  NagSuppressions.addResourceSuppressions(
    stage.workspaces.operatorRole,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'WorkSpaces lifecycle / application / image APIs and the read-only Describe/List calls do not support resource-level ' +
          'permissions for every action; the Deny statements (also Resource *) are what enforce R1/R2.',
        appliesTo: ['Resource::*', 'Action::workspaces:Describe*', 'Action::workspaces:List*'],
      },
    ],
    true
  );

  // ---------------------------------------------------------------- Usage report
  NagSuppressions.addResourceSuppressions(
    stage.usageReport.report,
    [
      lambdaBasicExecution,
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'DescribeWorkspaces / DescribeWorkspacesConnectionStatus do not support resource-level permissions.',
        appliesTo: ['Resource::*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'grantPut scoped to the reports/ prefix (s3:Abort* is part of the multipart upload grant).',
        appliesTo: [
          'Action::s3:Abort*',
          { regex: '/^Resource::<UsageReportReportBucket.+\\.Arn>\\/reports\\/\\*$/g' },
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'grantPublish on a topic encrypted with the imported alias aws/sns adds KMS data-key actions on key/*; the AWS ' +
          'managed key policy already limits use to SNS in this account.',
        appliesTo: [
          'Action::kms:GenerateDataKey*',
          'Resource::arn:aws:kms:ap-northeast-1:123456789012:key/*',
        ],
      },
    ],
    true
  );
  NagSuppressions.addStackSuppressions(stage.usageReport, [
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'EventBridge Scheduler target role: invoke any version of the report function (<arn>:*).',
      appliesTo: [{ regex: '/^Resource::<UsageReportFunction.+\\.Arn>:\\*$/g' }],
    },
  ]);

  cdk.Aspects.of(stage).add(new AwsSolutionsChecks({ verbose: true }));

  test.each(stacks.map((stack) => [stack.node.id, stack] as const))(
    '%s: no unsuppressed findings',
    (_name, stack) => {
      const findings = [
        ...Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*')),
        ...Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*')),
      ];
      if (findings.length > 0) {
        console.log(
          findings
            .map((f) => `${f.id}: ${String(f.entry.data).split('\n')[0].slice(0, 120)}`)
            .join('\n')
        );
      }
      expect(findings).toHaveLength(0);
    }
  );
});
