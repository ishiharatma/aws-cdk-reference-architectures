import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DiffEntry, DiffType, FetchEolDiffResult } from '../common/eol-types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME ?? '';
const DATASET_URL = process.env.DATASET_URL ?? '';
const UPCOMING_THRESHOLD_DAYS = Number(process.env.UPCOMING_THRESHOLD_DAYS ?? '180');

/** Shape of `awslabs/aws-service-eol-data`'s `data/eol.json` (schemaVersion 1.0). */
interface EolDataset {
  readonly schemaVersion: string;
  readonly lastUpdated: string;
  readonly services: EolService[];
}

interface EolService {
  readonly serviceCode: string;
  readonly serviceName: string;
  readonly engine: string | null;
  readonly versionType: string;
  readonly versions: EolVersion[];
}

interface EolVersion {
  readonly version: string;
  readonly status: 'STANDARD_SUPPORT' | 'EXTENDED_SUPPORT' | 'DEPRECATED' | 'END_OF_LIFE';
  readonly standardSupportEnd: string | null;
  readonly sourceUrl?: string;
}

/** Last-seen state for one (serviceCode, version) pair, persisted in DynamoDB. */
interface TrackedVersion {
  readonly serviceCode: string;
  readonly version: string;
  readonly status: string;
  readonly standardSupportEnd: string | null;
  readonly notifiedUpcoming: boolean;
}

async function fetchDataset(): Promise<EolDataset> {
  const res = await fetch(DATASET_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch EOL dataset: HTTP ${res.status} ${res.statusText} (${DATASET_URL})`);
  }
  return (await res.json()) as EolDataset;
}

async function loadTrackedVersions(): Promise<Map<string, TrackedVersion>> {
  const tracked = new Map<string, TrackedVersion>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of page.Items ?? []) {
      const record = item as TrackedVersion;
      tracked.set(`${record.serviceCode}#${record.version}`, record);
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return tracked;
}

function daysUntil(isoDate: string, now: Date): number {
  const target = new Date(`${isoDate}T00:00:00Z`).getTime();
  return Math.ceil((target - now.getTime()) / (1000 * 60 * 60 * 24));
}

export async function handler(): Promise<FetchEolDiffResult> {
  const now = new Date();
  const dataset = await fetchDataset();
  const tracked = await loadTrackedVersions();

  const diffs: DiffEntry[] = [];
  const writes: Promise<unknown>[] = [];
  let totalVersions = 0;

  for (const service of dataset.services) {
    for (const version of service.versions) {
      totalVersions += 1;
      const key = `${service.serviceCode}#${version.version}`;
      const previous = tracked.get(key);

      const isUpcoming =
        version.standardSupportEnd !== null &&
        daysUntil(version.standardSupportEnd, now) <= UPCOMING_THRESHOLD_DAYS &&
        daysUntil(version.standardSupportEnd, now) >= 0;

      let diffType: DiffType | undefined;
      if (!previous) {
        diffType = 'NEW';
      } else if (previous.status !== version.status) {
        diffType = 'STATUS_CHANGED';
      } else if (isUpcoming && !previous.notifiedUpcoming) {
        diffType = 'UPCOMING_EOL';
      }

      if (diffType) {
        diffs.push({
          type: diffType,
          serviceCode: service.serviceCode,
          serviceName: service.serviceName,
          version: version.version,
          status: version.status,
          standardSupportEnd: version.standardSupportEnd,
          previousStatus: previous?.status,
          daysUntilEol: version.standardSupportEnd ? daysUntil(version.standardSupportEnd, now) : undefined,
          sourceUrl: version.sourceUrl,
        });
      }

      // Persist current state whenever it differs from what we tracked, so
      // the next run's diff is against up-to-date data even without a
      // reportable change (e.g. sourceUrl-only edits upstream).
      const nextNotifiedUpcoming = previous?.notifiedUpcoming || diffType === 'UPCOMING_EOL';
      const stateChanged =
        !previous ||
        previous.status !== version.status ||
        previous.standardSupportEnd !== version.standardSupportEnd ||
        previous.notifiedUpcoming !== nextNotifiedUpcoming;

      if (stateChanged) {
        writes.push(
          ddb.send(
            new PutCommand({
              TableName: TABLE_NAME,
              Item: {
                serviceCode: service.serviceCode,
                version: version.version,
                serviceName: service.serviceName,
                status: version.status,
                standardSupportEnd: version.standardSupportEnd,
                notifiedUpcoming: nextNotifiedUpcoming,
                lastCheckedAt: now.toISOString(),
              },
            }),
          ),
        );
      }
    }
  }

  await Promise.all(writes);

  return {
    checkedAt: now.toISOString(),
    datasetLastUpdated: dataset.lastUpdated,
    totalServices: dataset.services.length,
    totalVersionsTracked: totalVersions,
    diffCount: diffs.length,
    diffs,
  };
}
