import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { LambdaMicrovmsClient, ListMicrovmsCommand, type MicrovmItem } from '@aws-sdk/client-lambda-microvms';

const microvms = new LambdaMicrovmsClient({});
const cloudwatch = new CloudWatchClient({});

/**
 * Counts MicroVMs of the worker image that are still RUNNING after the stale threshold.
 * A worker that finishes a session terminates itself, so a non-zero count means a missed self-termination.
 */
export const handler = async (): Promise<{ running: number; stale: number }> => {
  const imageIdentifier = process.env.MICROVM_IMAGE_ARN;
  const thresholdMs = Number(process.env.STALE_THRESHOLD_MINUTES) * 60 * 1000;
  const namespace = process.env.METRIC_NAMESPACE ?? 'ClaudeManagedAgents';

  const items: MicrovmItem[] = [];
  let nextToken: string | undefined;
  do {
    const page = await microvms.send(new ListMicrovmsCommand({ imageIdentifier, nextToken, maxResults: 100 }));
    items.push(...(page.items ?? []));
    nextToken = page.nextToken;
  } while (nextToken);

  const running = items.filter((vm) => vm.state === 'RUNNING');
  const now = Date.now();
  const stale = running.filter((vm) => vm.startedAt && now - new Date(vm.startedAt).getTime() > thresholdMs);

  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: namespace,
    MetricData: [
      { MetricName: 'RunningMicrovms', Value: running.length, Unit: 'Count' },
      { MetricName: 'StaleMicrovms', Value: stale.length, Unit: 'Count' },
    ],
  }));
  console.info(JSON.stringify({ running: running.length, stale: stale.map((vm) => vm.microvmId) }));
  return { running: running.length, stale: stale.length };
};
