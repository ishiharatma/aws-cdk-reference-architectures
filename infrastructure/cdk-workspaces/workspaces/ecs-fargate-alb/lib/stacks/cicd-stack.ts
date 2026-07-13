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
    /** CodeCommit リポジトリが存在する AWS アカウント ID */
    readonly codecommitAccountId: string;
    /** パイプライン通知トピック ARN */
    readonly notificationTopicArn?: string;
    /** S3 バケットライフサイクル設定 */
    readonly artifactLifecycle?: S3LifecycleConfig;
    /**
     * ソースアクションに使用する IAM ロール ARN
     * @default `arn:aws:iam::<codecommitAccountId>:role/<project>-pipeline-source-action-<accountId>`
     */
    readonly sourceRoleArn?: string;
    /**
     * パイプライン実行に使用する IAM ロール名
     * @default <project>-<env>-pipeline-role 
     */
    readonly pipelineRoleName?: string;
}
export class CICDStack extends cdk.Stack {

  public readonly infraPipeline: InfraPipelineConstruct;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const logRetentionDays = logs.RetentionDays.ONE_MONTH;
    const regionShort = this.region.replace(/-/g, '');
    const isRepositoryCrossAccount = props.codecommitAccountId !== this.account;
    const sourceRoleArn = props.sourceRoleArn ?? 
                        `arn:aws:iam::${props.codecommitAccountId}:role/${props.project}-pipeline-source-action-${this.account}`;
    const pipelineRoleName = props.pipelineRoleName ?? `${props.project}-${props.environment}-pipeline-role`;
    const artifactBucketName = `${props.project}-${props.environment}-pipeline-artifact-${this.account}-${regionShort}`.toLowerCase();

    /* ─── SNS 通知トピック ─────────────────────────────────────────────*/
    const notificationTopic: sns.ITopic = props.notificationTopicArn
      ? sns.Topic.fromTopicArn(this, 'NotificationTopic', props.notificationTopicArn)
      : new sns.Topic(this, 'NotificationTopic', {
          topicName: `${props.project}-${props.environment}-pipeline-notification`,
          displayName: `${props.project}-${props.environment} パイプライン失敗通知`,
        });

    /* ─── S3 アーティファクトバケット ──────────────────────────────────
     * クロスアカウント CodePipeline Source アクションには KMS キーが必須。
     * BucketEncryption.KMS を指定することで CMK が自動生成される。
     */
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: artifactBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      enforceSSL: true,
      removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.isAutoDeleteObject,
    });
    /* ── アーティファクトバケット ライフサイクルルール ────────────────*/
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
    /* ─── IAM Pipeline ロール ──────────────────────────────────────────*/
    /**
     * ロール名は <project>-<env>-pipeline-role に固定する。
     * クロスアカウント CodeCommit 参照にはリポジトリアカウント側でこのロール ARN を
     * CodeCommit ポリシーの Principal として追加すること。
     */
    const pipelineRole = new iam.Role(this, 'PipelineRole', {
      roleName: pipelineRoleName,
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
      description: `${props.project}-${props.environment} CodePipeline execution role`,
    });
    /* ─── クロスアカウント Source Action 用バケット / KMS ポリシー ────────
     * PipelineSourceRole（リポジトリアカウント）が
     * S3 アーティファクトバケットと KMS キーへアクセスできるよう
     * リソースポリシーを追加する。
     * CodeCommitSourceAction.role に リポジトリアカウントのロールを指定することで CDK の
     * クロスアカウントサポートスタック自動生成が抑止される。
     */
    if (props.codecommitAccountId && isRepositoryCrossAccount) {
      /* ── デフォルトイベントバス リソースポリシー ─────────────────────
       * リポジトリアカウントの EventBridge（<project>-to-dev-rule 等）が
       * このリソースアカウントのデフォルトイベントバスへ PutEvents できるよう許可する。
       * これがないとリポジトリアカウント → リソースアカウント のクロスアカウント転送がサイレントに破棄される。
       */
      new events.CfnEventBusPolicy(this, 'AllowProdEventBridgePutEvents', {
        statementId: 'AllowProdAccountEventBridgePutEvents',
        action: 'events:PutEvents',
        principal: props.codecommitAccountId,
      });

      artifactBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowCrossAccountSourceActionS3',
          principals: [new iam.ArnPrincipal(sourceRoleArn)],
          actions: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion', 's3:GetBucketVersioning'],
          resources: [artifactBucket.bucketArn, artifactBucket.arnForObjects('*')],
        })
      );
      artifactBucket.encryptionKey?.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowCrossAccountSourceActionKms',
          principals: [new iam.ArnPrincipal(sourceRoleArn)],
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey', 'kms:Encrypt', 'kms:ReEncrypt*'],
          resources: ['*'],
        })
      );
    }
    this.infraPipeline = new InfraPipelineConstruct(this, 'InfraPipeline', {
      project: props.project,
      environment: props.environment,
      codecommitAccountId: props.codecommitAccountId,
      pipelineRole,
      artifactBucket,
      notificationTopic,
      logRetentionDays,
    });


  }
}
