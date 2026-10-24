import {
  ConfigServiceClient,
  DescribeConfigurationRecorderStatusCommand,
  DescribeConfigurationRecordersCommand,
  SelectResourceConfigCommand,
} from '@aws-sdk/client-config-service';
import { aggregateStatus, classifyError } from '../common/status';
import { assertMonth, requireEnv, targetRegions } from '../common/env';
import { putJson, rawKey } from '../common/s3io';
import { CollectorEvent, CollectorOutput, RegionResult } from '../common/types';
import { recorderStatus } from './recorder';

/**
 * Configuration items that are bookkeeping rather than infrastructure, and
 * would dominate the item count.
 */
const SKIPPED_TYPES = new Set([
  'AWS::Config::ResourceCompliance',
  'AWS::Config::ConformancePackCompliance',
]);

const EXPRESSION =
  'SELECT resourceId, resourceName, resourceType, arn, awsRegion, availabilityZone, configuration, tags';

export interface ConfigItem {
  resourceId: string;
  resourceName?: string;
  resourceType: string;
  arn?: string;
  awsRegion: string;
  availabilityZone?: string;
  configuration?: unknown;
  tags?: { key: string; value: string }[];
}

async function collectRegion(
  region: string
): Promise<{ result: RegionResult; items: ConfigItem[] }> {
  const client = new ConfigServiceClient({ region });
  try {
    const [recorders, statuses] = await Promise.all([
      client.send(new DescribeConfigurationRecordersCommand({})),
      client.send(new DescribeConfigurationRecorderStatusCommand({})),
    ]);
    const recorder = recorderStatus(
      recorders.ConfigurationRecorders ?? [],
      statuses.ConfigurationRecordersStatus ?? []
    );
    if (recorder.status === 'DISABLED') {
      return { result: { region, ...recorder }, items: [] };
    }

    const items: ConfigItem[] = [];
    let token: string | undefined;
    do {
      const res = await client.send(
        new SelectResourceConfigCommand({ Expression: EXPRESSION, Limit: 100, NextToken: token })
      );
      for (const line of res.Results ?? []) {
        const item = JSON.parse(line) as ConfigItem;
        if (!SKIPPED_TYPES.has(item.resourceType)) {
          items.push(item);
        }
      }
      token = res.NextToken;
    } while (token);
    return { result: { region, ...recorder }, items };
  } catch (error) {
    return { result: { region, ...classifyError(error) }, items: [] };
  }
}

export const handler = async (event: CollectorEvent): Promise<CollectorOutput> => {
  const month = assertMonth(event.targetMonth);
  const perRegion = await Promise.all(targetRegions().map(collectRegion));
  const regions = perRegion.map((r) => r.result);
  const items = perRegion.flatMap((r) => r.items);

  const key = rawKey(month, 'config');
  await putJson(requireEnv('BUCKET_NAME'), key, {
    collectedAt: new Date().toISOString(),
    regions,
    items,
  });
  console.log(JSON.stringify({ regions, itemCount: items.length }));
  return {
    collector: 'config',
    results: [
      {
        source: 'config',
        status: aggregateStatus(regions),
        regions,
        s3Key: key,
        itemCount: items.length,
      },
    ],
  };
};
