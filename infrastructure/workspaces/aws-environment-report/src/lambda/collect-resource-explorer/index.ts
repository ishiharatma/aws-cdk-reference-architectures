import {
  GetDefaultViewCommand,
  GetIndexCommand,
  ListResourcesCommand,
  ResourceExplorer2Client,
} from '@aws-sdk/client-resource-explorer-2';
import { aggregateStatus, classifyError } from '../common/status';
import { assertMonth, requireEnv, targetRegions } from '../common/env';
import { putJson, rawKey } from '../common/s3io';
import { CollectorEvent, CollectorOutput, RegionResult } from '../common/types';

/**
 * Resource Explorer is only an inventory (ARN, type, region): it is used to
 * find resources AWS Config does not record, so the report can say how
 * complete the diagram is. It is optional; DISABLED just drops that check.
 */
export interface ExplorerItem {
  arn: string;
  region?: string;
  resourceType?: string;
  cfnResourceType?: string;
  service?: string;
}

async function collectRegion(
  region: string
): Promise<{ result: RegionResult; items: ExplorerItem[] }> {
  const client = new ResourceExplorer2Client({ region });
  try {
    const index = await client.send(new GetIndexCommand({}));
    if (index.State !== 'ACTIVE') {
      return {
        result: { region, status: 'DISABLED', message: `index state ${index.State ?? 'unknown'}` },
        items: [],
      };
    }
    const view = await client.send(new GetDefaultViewCommand({}));
    if (!view.ViewArn) {
      return {
        result: { region, status: 'DISABLED', message: 'no default view in this region' },
        items: [],
      };
    }

    // An aggregator index returns every region; filter to this one so each
    // region is counted once whatever the index type.
    const items: ExplorerItem[] = [];
    let token: string | undefined;
    do {
      const res = await client.send(
        new ListResourcesCommand({
          ViewArn: view.ViewArn,
          Filters: { FilterString: `region:${region}` },
          // MaxResults=1000 returns no NextToken (documented), which would silently truncate.
          MaxResults: 100,
          NextToken: token,
        })
      );
      for (const r of res.Resources ?? []) {
        if (r.Arn) {
          items.push({
            arn: r.Arn,
            region: r.Region,
            resourceType: r.ResourceType,
            cfnResourceType: r.CfnResourceType,
            service: r.Service,
          });
        }
      }
      token = res.NextToken;
    } while (token);
    return { result: { region, status: 'OK' }, items };
  } catch (error) {
    return { result: { region, ...classifyError(error) }, items: [] };
  }
}

export const handler = async (event: CollectorEvent): Promise<CollectorOutput> => {
  const month = assertMonth(event.targetMonth);
  const perRegion = await Promise.all(targetRegions().map(collectRegion));
  const regions = perRegion.map((r) => r.result);
  const items = perRegion.flatMap((r) => r.items);

  const key = rawKey(month, 'resource-explorer');
  await putJson(requireEnv('BUCKET_NAME'), key, {
    collectedAt: new Date().toISOString(),
    regions,
    items,
  });
  return {
    collector: 'resource-explorer',
    results: [
      {
        source: 'resource-explorer',
        status: aggregateStatus(regions),
        regions,
        s3Key: key,
        itemCount: items.length,
      },
    ],
  };
};
