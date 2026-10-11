import type { EC2Client } from '@aws-sdk/client-ec2';
import {
  CreateSecurityGroupCommand,
  CreateTagsCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  ModifyInstanceAttributeCommand,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import type { S3Client } from '@aws-sdk/client-s3';
import { GetBucketTaggingCommand, PutPublicAccessBlockCommand } from '@aws-sdk/client-s3';
import type { SecurityHubClient } from '@aws-sdk/client-securityhub';
import { BatchUpdateFindingsCommand } from '@aws-sdk/client-securityhub';
import type { SNSClient } from '@aws-sdk/client-sns';
import { PublishCommand } from '@aws-sdk/client-sns';

/** The parts of an AWS Security Finding Format (ASFF) finding this remediator reads. */
export interface AsffFinding {
  readonly Id: string;
  readonly ProductArn: string;
  readonly ProductName?: string;
  readonly Title?: string;
  readonly Severity?: { readonly Label?: string };
  readonly Compliance?: { readonly Status?: string; readonly SecurityControlId?: string };
  readonly ProductFields?: Record<string, string>;
  readonly Resources?: readonly { readonly Type?: string; readonly Id?: string }[];
}

export type RemediationKind = 'block-s3-public-access' | 'revoke-open-admin-ports' | 'quarantine-instance';
export type Outcome = 'remediated' | 'dry-run' | 'skipped';

export interface RemediationResult {
  readonly kind: RemediationKind;
  readonly resource: string;
  readonly outcome: Outcome;
  readonly detail: string;
}

export interface RemediatorConfig {
  /** `dry-run` records what would be done and changes nothing; `enforce` applies the change. */
  readonly mode: 'dry-run' | 'enforce';
  /** Security Hub control IDs about S3 buckets that are not blocking public access. */
  readonly s3ControlIds: string[];
  /** Security Hub control IDs about security groups open to the internet on remote administration ports. */
  readonly sgControlIds: string[];
  /** Ports whose 0.0.0.0/0 and ::/0 ingress rules are revoked. Other rules are never touched. */
  readonly remoteAdminPorts: number[];
  /** Lowest GuardDuty severity label (via Security Hub) that quarantines an instance. */
  readonly guardDutyMinSeverity: 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Product names whose findings are trusted. `Default` is the product of custom imported findings (test hook). */
  readonly trustedProducts: string[];
  /** A resource carrying this tag with the value `true` is never remediated. */
  readonly skipTagKey: string;
  /** Prefix for the quarantine security group and the tags written to quarantined instances. */
  readonly namePrefix: string;
  readonly topicArn?: string;
}

export interface Clients {
  readonly s3: Pick<S3Client, 'send'>;
  readonly ec2: Pick<EC2Client, 'send'>;
  readonly securityHub: Pick<SecurityHubClient, 'send'>;
  readonly sns: Pick<SNSClient, 'send'>;
}

const SEVERITY_RANK: Record<string, number> = { INFORMATIONAL: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/** Returns the control ID of a Security Hub control finding, from either of the fields it appears in. */
export const controlIdOf = (f: AsffFinding): string | undefined =>
  f.Compliance?.SecurityControlId ?? f.ProductFields?.ControlId;

/** `arn:aws:s3:::name` -> `name`. */
export const bucketNameOf = (arn: string): string => arn.replace(/^arn:[^:]*:s3:::/, '').split('/')[0];

/** `arn:aws:ec2:region:acct:security-group/sg-1` or a bare id -> `sg-1`. */
export const resourceIdOf = (arn: string): string => arn.split('/').pop() ?? arn;

/**
 * Decides which remediation, if any, a finding calls for. Only trusted products, failed or active findings and
 * the configured controls qualify, so an unrelated finding is never acted on.
 */
export const classify = (f: AsffFinding, config: RemediatorConfig): { kind: RemediationKind; resourceId: string } | undefined => {
  if (!f.ProductName || !config.trustedProducts.includes(f.ProductName)) return undefined;
  const resource = f.Resources?.[0];
  if (!resource?.Id || !resource.Type) return undefined;

  if (f.ProductName === 'GuardDuty' || f.ProductFields?.['aws/guardduty/service/serviceName'] === 'guardduty'
    || (f.ProductName === 'Default' && !controlIdOf(f))) {
    const rank = SEVERITY_RANK[f.Severity?.Label ?? 'INFORMATIONAL'] ?? 0;
    if (resource.Type === 'AwsEc2Instance' && rank >= SEVERITY_RANK[config.guardDutyMinSeverity]) {
      return { kind: 'quarantine-instance', resourceId: resourceIdOf(resource.Id) };
    }
    return undefined;
  }

  const control = controlIdOf(f);
  if (!control || f.Compliance?.Status !== 'FAILED') return undefined;
  if (config.s3ControlIds.includes(control) && resource.Type === 'AwsS3Bucket') {
    return { kind: 'block-s3-public-access', resourceId: bucketNameOf(resource.Id) };
  }
  if (config.sgControlIds.includes(control) && resource.Type === 'AwsEc2SecurityGroup') {
    return { kind: 'revoke-open-admin-ports', resourceId: resourceIdOf(resource.Id) };
  }
  return undefined;
};

const isSkipTag = (tags: readonly { Key?: string; Value?: string }[] | undefined, key: string): boolean =>
  (tags ?? []).some((t) => t.Key === key && t.Value === 'true');

/** Applies one remediation at a time and reports what happened. Every AWS call goes through the injected clients. */
export class Remediator {
  constructor(private readonly clients: Clients, private readonly config: RemediatorConfig) {}

  /** Handles every finding of one Security Hub event. A failure in one finding never stops the others. */
  async handle(findings: AsffFinding[]): Promise<RemediationResult[]> {
    const results: RemediationResult[] = [];
    for (const finding of findings) {
      const action = classify(finding, this.config);
      if (!action) continue;
      const result = await this.run(action.kind, action.resourceId);
      results.push(result);
      await this.report(finding, result);
    }
    return results;
  }

  private async run(kind: RemediationKind, id: string): Promise<RemediationResult> {
    switch (kind) {
      case 'block-s3-public-access': return this.blockS3PublicAccess(id);
      case 'revoke-open-admin-ports': return this.revokeOpenAdminPorts(id);
      case 'quarantine-instance': return this.quarantineInstance(id);
    }
  }

  private result(kind: RemediationKind, resource: string, outcome: Outcome, detail: string): RemediationResult {
    return { kind, resource, outcome, detail };
  }

  private async blockS3PublicAccess(bucket: string): Promise<RemediationResult> {
    const kind = 'block-s3-public-access';
    const tags = await this.clients.s3.send(new GetBucketTaggingCommand({ Bucket: bucket })).then((r) => r.TagSet).catch(() => undefined);
    if (isSkipTag(tags, this.config.skipTagKey)) return this.result(kind, bucket, 'skipped', `tag ${this.config.skipTagKey}=true`);
    if (this.config.mode === 'dry-run') return this.result(kind, bucket, 'dry-run', 'would enable all four Block Public Access settings');
    await this.clients.s3.send(new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
      },
    }));
    return this.result(kind, bucket, 'remediated', 'enabled all four Block Public Access settings');
  }

  private async revokeOpenAdminPorts(groupId: string): Promise<RemediationResult> {
    const kind = 'revoke-open-admin-ports';
    const { SecurityGroups } = await this.clients.ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
    const group = SecurityGroups?.[0];
    if (!group) return this.result(kind, groupId, 'skipped', 'security group not found');
    if (isSkipTag(group.Tags, this.config.skipTagKey)) return this.result(kind, groupId, 'skipped', `tag ${this.config.skipTagKey}=true`);

    // Only the open ranges on the configured ports are revoked; a rule that covers other ports or other sources stays.
    const revoke = (group.IpPermissions ?? []).flatMap((p) => {
      const covers = (port: number) => (p.IpProtocol === '-1') || (p.FromPort !== undefined && p.ToPort !== undefined && p.FromPort <= port && port <= p.ToPort);
      if (!this.config.remoteAdminPorts.some(covers)) return [];
      const v4 = (p.IpRanges ?? []).filter((r) => r.CidrIp === '0.0.0.0/0');
      const v6 = (p.Ipv6Ranges ?? []).filter((r) => r.CidrIpv6 === '::/0');
      if (v4.length === 0 && v6.length === 0) return [];
      return [{ IpProtocol: p.IpProtocol, FromPort: p.FromPort, ToPort: p.ToPort, IpRanges: v4, Ipv6Ranges: v6 }];
    });
    if (revoke.length === 0) return this.result(kind, groupId, 'skipped', 'no open rule on the configured ports');
    const summary = revoke.map((p) => `${p.IpProtocol}/${p.FromPort}-${p.ToPort}`).join(', ');
    if (this.config.mode === 'dry-run') return this.result(kind, groupId, 'dry-run', `would revoke ${summary} from 0.0.0.0/0 and ::/0`);
    await this.clients.ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions: revoke }));
    return this.result(kind, groupId, 'remediated', `revoked ${summary} from 0.0.0.0/0 and ::/0`);
  }

  private async quarantineInstance(instanceId: string): Promise<RemediationResult> {
    const kind = 'quarantine-instance';
    const { Reservations } = await this.clients.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] })).catch(() => ({ Reservations: undefined }));
    const instance = Reservations?.[0]?.Instances?.[0];
    if (!instance?.VpcId) return this.result(kind, instanceId, 'skipped', 'instance not found (for example a GuardDuty sample finding)');
    if (isSkipTag(instance.Tags, this.config.skipTagKey)) return this.result(kind, instanceId, 'skipped', `tag ${this.config.skipTagKey}=true`);
    const original = (instance.SecurityGroups ?? []).map((g) => g.GroupId).filter((g): g is string => !!g);
    const quarantineName = `${this.config.namePrefix}-quarantine`;
    const existing = await this.clients.ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [{ Name: 'vpc-id', Values: [instance.VpcId] }, { Name: 'group-name', Values: [quarantineName] }],
    }));
    if (existing.SecurityGroups?.[0]?.GroupId && original.length === 1 && original[0] === existing.SecurityGroups[0].GroupId) {
      return this.result(kind, instanceId, 'skipped', 'already quarantined');
    }
    if (this.config.mode === 'dry-run') return this.result(kind, instanceId, 'dry-run', `would replace ${original.join(',')} with ${quarantineName}`);

    let groupId = existing.SecurityGroups?.[0]?.GroupId;
    if (!groupId) {
      groupId = (await this.clients.ec2.send(new CreateSecurityGroupCommand({
        GroupName: quarantineName,
        Description: 'No inbound or outbound traffic: used to isolate an instance after a finding',
        VpcId: instance.VpcId,
      }))).GroupId;
      if (!groupId) throw new Error('the quarantine security group was not created');
      // A new security group allows all outbound traffic; the quarantine group must allow none.
      await this.clients.ec2.send(new RevokeSecurityGroupEgressCommand({
        GroupId: groupId,
        IpPermissions: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }], Ipv6Ranges: [{ CidrIpv6: '::/0' }] }],
      }));
    }
    await this.clients.ec2.send(new CreateTagsCommand({
      Resources: [instanceId],
      Tags: [
        { Key: `${this.config.namePrefix}:quarantined`, Value: 'true' },
        { Key: `${this.config.namePrefix}:original-security-groups`, Value: original.join(',') },
      ],
    }));
    await this.clients.ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: instanceId, Groups: [groupId] }));
    return this.result(kind, instanceId, 'remediated', `replaced ${original.join(',')} with ${quarantineName} (${groupId}); original groups kept in a tag`);
  }

  /** Writes the outcome back to the finding and tells the topic. Failures here are logged, not thrown. */
  private async report(finding: AsffFinding, result: RemediationResult): Promise<void> {
    const text = `[${result.outcome}] ${result.kind} on ${result.resource}: ${result.detail}`;
    console.log(JSON.stringify({ message: 'remediation', findingId: finding.Id, ...result }));
    await this.clients.securityHub.send(new BatchUpdateFindingsCommand({
      FindingIdentifiers: [{ Id: finding.Id, ProductArn: finding.ProductArn }],
      Note: { Text: text.slice(0, 512), UpdatedBy: `${this.config.namePrefix}-remediation` },
      ...(result.outcome === 'remediated' ? { Workflow: { Status: 'RESOLVED' as const } } : {}),
    })).catch((e) => console.error(JSON.stringify({ message: 'could not update the finding', error: String(e) })));
    if (this.config.topicArn) {
      await this.clients.sns.send(new PublishCommand({
        TopicArn: this.config.topicArn,
        Subject: `Remediation ${result.outcome}: ${result.kind}`.slice(0, 100),
        Message: `${text}\nFinding: ${finding.Title ?? finding.Id}\nFinding ID: ${finding.Id}`,
      })).catch((e) => console.error(JSON.stringify({ message: 'could not publish', error: String(e) })));
    }
  }
}
