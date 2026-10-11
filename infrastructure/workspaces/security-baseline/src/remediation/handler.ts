import { EC2Client } from '@aws-sdk/client-ec2';
import { S3Client } from '@aws-sdk/client-s3';
import { SecurityHubClient } from '@aws-sdk/client-securityhub';
import { SNSClient } from '@aws-sdk/client-sns';
import type { EventBridgeEvent } from 'aws-lambda';
import { AsffFinding, Remediator, RemediatorConfig } from './remediator';

const list = (name: string): string[] => (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Reads the settings the stack passes in as environment variables. */
export const configFromEnv = (): RemediatorConfig => ({
  mode: process.env.MODE === 'enforce' ? 'enforce' : 'dry-run',
  s3ControlIds: list('S3_CONTROL_IDS'),
  sgControlIds: list('SG_CONTROL_IDS'),
  remoteAdminPorts: list('REMOTE_ADMIN_PORTS').map(Number),
  guardDutyMinSeverity: (process.env.GUARDDUTY_MIN_SEVERITY as RemediatorConfig['guardDutyMinSeverity']) ?? 'HIGH',
  trustedProducts: list('TRUSTED_PRODUCTS'),
  skipTagKey: process.env.SKIP_TAG_KEY ?? 'security-baseline:remediation-skip',
  namePrefix: process.env.NAME_PREFIX ?? 'security-baseline',
  topicArn: process.env.TOPIC_ARN,
});

const remediator = new Remediator(
  { s3: new S3Client({}), ec2: new EC2Client({}), securityHub: new SecurityHubClient({}), sns: new SNSClient({}) },
  configFromEnv(),
);

/** Entry point of the "Security Hub Findings - Imported" EventBridge rule. */
export const handler = async (event: EventBridgeEvent<'Security Hub Findings - Imported', { findings: AsffFinding[] }>) => {
  const results = await remediator.handle(event.detail.findings);
  return { handled: results.length, results };
};
