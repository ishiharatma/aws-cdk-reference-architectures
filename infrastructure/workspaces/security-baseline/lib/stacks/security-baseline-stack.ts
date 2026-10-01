import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { AccessAnalyzerConstruct } from 'lib/constructs/access-analyzer-construct';
import { CloudTrailConstruct } from 'lib/constructs/cloudtrail-construct';
import { ConfigConstruct } from 'lib/constructs/config-construct';
import { GuardDutyConstruct } from 'lib/constructs/guardduty-construct';
import { LogArchiveConstruct } from 'lib/constructs/log-archive-construct';
import { NotificationConstruct } from 'lib/constructs/notification-construct';
import { SecurityHubConstruct } from 'lib/constructs/security-hub-construct';

/** Properties for {@link SecurityBaselineStack}. */
export interface SecurityBaselineStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Single-account security baseline.
 *
 *   API activity ──► CloudTrail (multi-Region) ──► S3 log archive (SSE + CMK) + CloudWatch Logs
 *   Resource config ─► AWS Config recorder ─────► S3 log archive, managed rules
 *   Threats ────────► GuardDuty detector ─────┐
 *   Public / unused access ► Access Analyzer ─┼─► Security Hub (AWS Foundational Security Best Practices)
 *   Config rules & controls ──────────────────┘
 *
 * Detection only: nothing here blocks or remediates. High-severity findings are emailed through
 *   Security Hub ─► EventBridge rule ─► SNS topic ─► email
 * and all findings can be read in Security Hub.
 * These services are account-and-Region singletons; see the README for what happens if any is already enabled.
 */
export class SecurityBaselineStack extends cdk.Stack {
  /**
   * Wires the audit trail, configuration history, detection services and Security Hub together.
   *
   * @param scope - parent construct
   * @param id - construct ID
   * @param props - project, environment and parameters
   */
  constructor(scope: Construct, id: string, props: SecurityBaselineStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const namePrefix = `${project}-${environment}-secbase`;

    // ---------------------------------------------------------------------------------------------
    // Audit trail and configuration history
    // ---------------------------------------------------------------------------------------------
    const archive = new LogArchiveConstruct(this, 'LogArchive', {
      expirationDays: params.logArchiveExpirationDays,
      isAutoDeleteObject,
    });

    const trail = new CloudTrailConstruct(this, 'CloudTrail', {
      trailName: `${namePrefix}-trail`,
      bucket: archive.bucket,
      key: archive.key,
      logGroupRetentionDays: params.trailLogGroupRetentionDays,
      isAutoDeleteObject,
    });

    const configService = new ConfigConstruct(this, 'Config', { namePrefix, bucket: archive.bucket });

    // ---------------------------------------------------------------------------------------------
    // Detection and aggregation
    // ---------------------------------------------------------------------------------------------
    const guardDuty = new GuardDutyConstruct(this, 'GuardDuty', { features: params.guardDuty });

    const accessAnalyzer = new AccessAnalyzerConstruct(this, 'AccessAnalyzer', {
      namePrefix,
      enableUnusedAccess: params.enableUnusedAccessAnalyzer,
      unusedAccessAgeDays: params.unusedAccessAgeDays,
    });

    const securityHub = new SecurityHubConstruct(this, 'SecurityHub', {
      configRecorder: configService.recorderReady,
      additionalStandardArns: params.additionalSecurityHubStandardArns,
    });
    // Enable producers before the hub so their first findings are accepted.
    securityHub.node.addDependency(guardDuty);
    securityHub.node.addDependency(accessAnalyzer);

    // ---------------------------------------------------------------------------------------------
    // Notification: Security Hub findings -> EventBridge -> SNS -> email
    // ---------------------------------------------------------------------------------------------
    const notification = new NotificationConstruct(this, 'Notification', {
      namePrefix,
      key: archive.key,
      severities: params.notification.severities,
      emails: params.notification.emails,
      isAutoDeleteObject,
    });

    // ---------------------------------------------------------------------------------------------
    // Outputs (human-facing; not consumed by other stacks)
    // ---------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'LogArchiveBucketName', { value: archive.bucket.bucketName });
    new cdk.CfnOutput(this, 'TrailArn', { value: trail.trail.trailArn });
    new cdk.CfnOutput(this, 'GuardDutyDetectorId', { value: guardDuty.detector.ref });
    new cdk.CfnOutput(this, 'SecurityHubArn', { value: securityHub.hub.attrArn });
    new cdk.CfnOutput(this, 'FindingsTopicArn', { value: notification.topic.topicArn });
  }
}
