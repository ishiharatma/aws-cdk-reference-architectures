import { DescribeInstancesCommand, EC2Client, StopInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';

const ec2 = new EC2Client({});
const MAX_RUNNING_HOURS = Number(process.env.EC2_MAX_RUNNING_HOURS ?? '8');

/**
 * Scheduled. MicroVMs have an idle policy and a lifetime limit; EC2 has neither, so this gives
 * instances the same bounds: stop after the running limit, terminate after the session deadline.
 */
export async function handler(): Promise<{ stopped: string[]; terminated: string[] }> {
  const result = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:CodeServerSessions', Values: [process.env.NAME_PREFIX ?? ''] },
        { Name: 'instance-state-name', Values: ['running', 'stopped'] },
      ],
    }),
  );
  const instances = (result.Reservations ?? []).flatMap((r) => r.Instances ?? []);

  const now = Date.now();
  const stopped: string[] = [];
  const terminated: string[] = [];
  for (const instance of instances) {
    const expiresAt = Number(instance.Tags?.find((t) => t.Key === 'ExpiresAt')?.Value ?? 0);
    if (expiresAt * 1000 <= now) {
      terminated.push(instance.InstanceId as string);
    } else if (instance.State?.Name === 'running' && now - (instance.LaunchTime?.getTime() ?? now) >= MAX_RUNNING_HOURS * 3_600_000) {
      stopped.push(instance.InstanceId as string);
    }
  }
  if (terminated.length > 0) await ec2.send(new TerminateInstancesCommand({ InstanceIds: terminated }));
  if (stopped.length > 0) await ec2.send(new StopInstancesCommand({ InstanceIds: stopped }));
  console.log(JSON.stringify({ checked: instances.length, stopped, terminated }));
  return { stopped, terminated };
}
