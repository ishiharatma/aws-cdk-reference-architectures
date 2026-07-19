import * as cdk from "aws-cdk-lib";
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as events from 'aws-cdk-lib/aws-events';

import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from "parameters/environments";
import { S3LifecycleConfig } from '@common/types';
import { InfraPipelineConstruct } from '@common/constructs/pipeline/infra-pipeline-construct';

export interface StackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    /** AWS account ID where the CodeCommit repository lives 
     * If not specified, the current account is used.
    */
    readonly codecommitAccountId?: string;
    /** Pipeline notification topic ARN */
    readonly notificationTopicArn?: string;
    /** S3 bucket lifecycle configuration */
    readonly artifactLifecycle?: S3LifecycleConfig;
    /**
     * IAM role name used for pipeline execution
     * @default <project>-<env>-pipeline-role
     */
    readonly pipelineRoleName?: string;
}
export class CICDStack extends cdk.Stack {

  public readonly infraPipeline: InfraPipelineConstruct;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const logRetentionDays = logs.RetentionDays.ONE_MONTH;
    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;
    const regionShort = region.replace(/-/g, '');
    const pipelineRoleName = props.pipelineRoleName ?? `${props.project}-${props.environment}-pipeline-role`;
    const artifactBucketName = `${props.project}-${props.environment}-artifact-${accountId}-${regionShort}`.toLowerCase();

    /* ─── SNS notification topic ─────────────────────────────────────────────*/
    const notificationTopic: sns.ITopic = props.notificationTopicArn
      ? sns.Topic.fromTopicArn(this, 'NotificationTopic', props.notificationTopicArn)
      : new sns.Topic(this, 'NotificationTopic', {
          topicName: `${props.project}-${props.environment}-pipeline-notification`,
          displayName: `${props.project}-${props.environment} pipeline failure notification`,
        });

    /* ─── S3 artifact bucket ────────────────────────────────── */
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: artifactBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.isAutoDeleteObject,
    });
    /* ── Artifact bucket lifecycle rules ────────────────*/
    if (props.artifactLifecycle) {
      const lc = props.artifactLifecycle;
      const transitions: s3.Transition[] = [];
      if (lc.standardIaDays !== undefined) {
        transitions.push({
          storageClass: s3.StorageClass.INFREQUENT_ACCESS,
          transitionAfter: cdk.Duration.days(lc.standardIaDays),
        });
      }
      if (lc.glacierFlexibleDays !== undefined) {
        transitions.push({
          storageClass: s3.StorageClass.GLACIER,
          transitionAfter: cdk.Duration.days(lc.glacierFlexibleDays),
        });
      }
      if (lc.glacierDeepArchiveDays !== undefined) {
        transitions.push({
          storageClass: s3.StorageClass.DEEP_ARCHIVE,
          transitionAfter: cdk.Duration.days(lc.glacierDeepArchiveDays),
        });
      }
      const hasLifecycle = transitions.length > 0 || lc.expirationDays !== undefined;
      if (hasLifecycle) {
        artifactBucket.addLifecycleRule({
          enabled: true,
          transitions: transitions.length > 0 ? transitions : undefined,
          expiration:
            lc.expirationDays !== undefined ? cdk.Duration.days(lc.expirationDays) : undefined,
        });
      }
    }
    /* ─── IAM pipeline role ──────────────────────────────────────────*/
    const pipelineRole = new iam.Role(this, 'PipelineRole', {
      roleName: pipelineRoleName,
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
      description: `${props.project}-${props.environment} CodePipeline execution role`,
    });
    this.infraPipeline = new InfraPipelineConstruct(this, 'InfraPipeline', {
      project: props.project,
      environment: props.environment,
      codecommitAccountId: props.codecommitAccountId ?? accountId,
      pipelineRole,
      artifactBucket,
      notificationTopic,
      logRetentionDays,
      buildSpecPath: 'infra',
      buildSpecFileName: 'buildspec-ci.yml',
    });


  }
}
