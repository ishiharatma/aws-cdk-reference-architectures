import {
  AccessAnalyzerClient,
  ListAnalyzersCommand,
  ListFindingsCommand as ListAaFindingsCommand,
} from '@aws-sdk/client-accessanalyzer';
import {
  GetDetectorCommand,
  GetFindingsCommand as GetGdFindingsCommand,
  GuardDutyClient,
  ListDetectorsCommand,
  ListFindingsCommand as ListGdFindingsCommand,
} from '@aws-sdk/client-guardduty';
import {
  BatchGetAccountStatusCommand,
  Inspector2Client,
  ListFindingsCommand as ListInspectorFindingsCommand,
} from '@aws-sdk/client-inspector2';
import {
  DescribeHubCommand,
  GetFindingsCommand as GetShFindingsCommand,
  SecurityHubClient,
} from '@aws-sdk/client-securityhub';
import { aggregateStatus, classifyError } from '../common/status';
import { assertMonth, requireEnv, targetRegions } from '../common/env';
import { putJson, rawKey } from '../common/s3io';
import { CollectorEvent, CollectorOutput, RegionResult, SourceResult } from '../common/types';
import {
  NormalizedFinding,
  accessAnalyzerSeverity,
  dedupeFindings,
  extractResourceIds,
  guardDutySeverity,
  labelSeverity,
} from './normalize';

type Source = NormalizedFinding['source'];
type RegionCollector = (
  region: string,
  max: number
) => Promise<{ result: RegionResult; findings: NormalizedFinding[] }>;

/** Result for a region whose collection was cut at `max` findings. */
function capped(region: string, count: number, max: number): RegionResult {
  return count >= max
    ? { region, status: 'PARTIAL', message: `stopped at maxFindingsPerSource (${max})` }
    : { region, status: 'OK' };
}

/**
 * Security Hub CSPM control findings only (ProductName "Security Hub"):
 * GuardDuty / Inspector / Access Analyzer findings imported into Security Hub
 * are read from those services directly, so they would otherwise be counted twice.
 */
const securityHub: RegionCollector = async (region, max) => {
  const client = new SecurityHubClient({ region });
  await client.send(new DescribeHubCommand({}));
  const findings: NormalizedFinding[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new GetShFindingsCommand({
        Filters: {
          RecordState: [{ Value: 'ACTIVE', Comparison: 'EQUALS' }],
          WorkflowStatus: [
            { Value: 'NEW', Comparison: 'EQUALS' },
            { Value: 'NOTIFIED', Comparison: 'EQUALS' },
          ],
          ProductName: [{ Value: 'Security Hub', Comparison: 'EQUALS' }],
          ComplianceStatus: [{ Value: 'FAILED', Comparison: 'EQUALS' }],
        },
        MaxResults: 100,
        NextToken: token,
      })
    );
    for (const f of res.Findings ?? []) {
      findings.push({
        source: 'securityhub',
        region,
        severity: labelSeverity(f.Severity?.Label),
        title: f.Title ?? f.Compliance?.SecurityControlId ?? 'Security Hub finding',
        type: f.Compliance?.SecurityControlId,
        resourceIds: (f.Resources ?? []).map((r) => r.Id).filter((id): id is string => !!id),
        resourceType: f.Resources?.[0]?.Type,
        updatedAt: f.UpdatedAt,
      });
    }
    token = findings.length < max ? res.NextToken : undefined;
  } while (token);
  return { result: capped(region, findings.length, max), findings: findings.slice(0, max) };
};

const guardDuty: RegionCollector = async (region, max) => {
  const client = new GuardDutyClient({ region });
  const detectors = await client.send(new ListDetectorsCommand({}));
  const detectorId = detectors.DetectorIds?.[0];
  if (!detectorId) {
    return { result: { region, status: 'DISABLED', message: 'no detector' }, findings: [] };
  }
  const detector = await client.send(new GetDetectorCommand({ DetectorId: detectorId }));
  if (detector.Status !== 'ENABLED') {
    return {
      result: { region, status: 'DISABLED', message: `detector ${detector.Status}` },
      findings: [],
    };
  }

  const ids: string[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListGdFindingsCommand({
        DetectorId: detectorId,
        FindingCriteria: { Criterion: { 'service.archived': { Equals: ['false'] } } },
        MaxResults: 50,
        NextToken: token,
      })
    );
    ids.push(...(res.FindingIds ?? []));
    token = ids.length < max ? res.NextToken || undefined : undefined;
  } while (token);

  const findings: NormalizedFinding[] = [];
  const limited = ids.slice(0, max);
  for (let i = 0; i < limited.length; i += 50) {
    const res = await client.send(
      new GetGdFindingsCommand({ DetectorId: detectorId, FindingIds: limited.slice(i, i + 50) })
    );
    for (const f of res.Findings ?? []) {
      findings.push({
        source: 'guardduty',
        region,
        severity: guardDutySeverity(f.Severity),
        title: f.Title ?? f.Type ?? 'GuardDuty finding',
        type: f.Type,
        resourceIds: extractResourceIds(f.Resource),
        resourceType: f.Resource?.ResourceType,
        updatedAt: f.UpdatedAt,
      });
    }
  }
  return { result: capped(region, ids.length, max), findings };
};

const accessAnalyzer: RegionCollector = async (region, max) => {
  const client = new AccessAnalyzerClient({ region });
  const analyzers = await client.send(new ListAnalyzersCommand({ type: 'ACCOUNT' }));
  const analyzer = analyzers.analyzers?.find((a) => a.status === 'ACTIVE');
  if (!analyzer?.arn) {
    return {
      result: { region, status: 'DISABLED', message: 'no active account analyzer' },
      findings: [],
    };
  }
  const findings: NormalizedFinding[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListAaFindingsCommand({
        analyzerArn: analyzer.arn,
        filter: { status: { eq: ['ACTIVE'] } },
        maxResults: 100,
        nextToken: token,
      })
    );
    for (const f of res.findings ?? []) {
      findings.push({
        source: 'access-analyzer',
        region,
        severity: accessAnalyzerSeverity(f.isPublic),
        title: `${f.isPublic ? 'Public' : 'External'} access: ${f.resourceType ?? 'resource'}`,
        type: f.resourceType,
        resourceIds: f.resource ? [f.resource] : [],
        resourceType: f.resourceType,
        updatedAt: f.updatedAt?.toISOString(),
      });
    }
    token = findings.length < max ? res.nextToken : undefined;
  } while (token);
  return { result: capped(region, findings.length, max), findings: findings.slice(0, max) };
};

const inspector: RegionCollector = async (region, max) => {
  const client = new Inspector2Client({ region });
  const status = await client.send(new BatchGetAccountStatusCommand({}));
  const state = status.accounts?.[0]?.state?.status;
  if (state !== 'ENABLED') {
    return {
      result: { region, status: 'DISABLED', message: `Inspector ${state ?? 'not enabled'}` },
      findings: [],
    };
  }
  const findings: NormalizedFinding[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListInspectorFindingsCommand({
        filterCriteria: { findingStatus: [{ comparison: 'EQUALS', value: 'ACTIVE' }] },
        maxResults: 100,
        nextToken: token,
      })
    );
    for (const f of res.findings ?? []) {
      findings.push({
        source: 'inspector',
        region,
        severity: labelSeverity(f.severity),
        title: f.title ?? f.type ?? 'Inspector finding',
        type: f.type,
        resourceIds: (f.resources ?? []).map((r) => r.id).filter((id): id is string => !!id),
        resourceType: f.resources?.[0]?.type,
        updatedAt: f.updatedAt?.toISOString(),
      });
    }
    token = findings.length < max ? res.nextToken : undefined;
  } while (token);
  return { result: capped(region, findings.length, max), findings: findings.slice(0, max) };
};

const COLLECTORS: Record<Source, RegionCollector> = {
  securityhub: securityHub,
  guardduty: guardDuty,
  'access-analyzer': accessAnalyzer,
  inspector,
};

async function runSource(source: Source, regions: string[], max: number) {
  const perRegion = await Promise.all(
    regions.map(async (region) => {
      try {
        return await COLLECTORS[source](region, max);
      } catch (error) {
        return {
          result: { region, ...classifyError(error) } as RegionResult,
          findings: [] as NormalizedFinding[],
        };
      }
    })
  );
  return {
    regions: perRegion.map((r) => r.result),
    findings: perRegion.flatMap((r) => r.findings),
  };
}

export const handler = async (event: CollectorEvent): Promise<CollectorOutput> => {
  const month = assertMonth(event.targetMonth);
  const regions = targetRegions();
  const max = Number(requireEnv('MAX_FINDINGS_PER_SOURCE'));
  const bucket = requireEnv('BUCKET_NAME');

  const results: SourceResult[] = [];
  const all: Record<string, unknown> = {};
  for (const source of Object.keys(COLLECTORS) as Source[]) {
    const { regions: regionResults, findings } = await runSource(source, regions, max);
    const kept = dedupeFindings(findings);
    all[source] = { regions: regionResults, findings: kept };
    results.push({
      source,
      status: aggregateStatus(regionResults),
      regions: regionResults,
      itemCount: kept.length,
    });
  }

  const key = rawKey(month, 'security');
  await putJson(bucket, key, { collectedAt: new Date().toISOString(), sources: all });
  return { collector: 'security', results: results.map((r) => ({ ...r, s3Key: key })) };
};
