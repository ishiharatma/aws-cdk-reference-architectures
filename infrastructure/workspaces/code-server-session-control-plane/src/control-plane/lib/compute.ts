import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import type { Compute, SessionRecord, SessionState } from './session-store';

const microvms = new LambdaMicrovmsClient({});
const ec2 = new EC2Client({});

const EC2_STATES: Record<string, SessionState> = {
  pending: 'PENDING',
  running: 'RUNNING',
  stopping: 'SUSPENDING',
  stopped: 'SUSPENDED',
  'shutting-down': 'TERMINATING',
  terminated: 'TERMINATED',
};

export interface StartedCompute {
  readonly resourceId: string;
  readonly endpoint?: string;
  readonly state: SessionState;
}

export const isEc2Enabled = (): boolean => Boolean(process.env.EC2_LAUNCH_TEMPLATE_ID);

async function startMicrovm(sessionId: string, ownerEmail?: string, workspaceToken?: string): Promise<StartedCompute> {
  const result = await microvms.send(
    new RunMicrovmCommand({
      imageIdentifier: process.env.MICROVM_IMAGE_ARN ?? '',
      executionRoleArn: process.env.MICROVM_EXECUTION_ROLE_ARN ?? '',
      egressNetworkConnectors: [process.env.MICROVM_EGRESS_CONNECTOR_ARN ?? ''],
      logging: { cloudWatch: { logGroup: process.env.MICROVM_LOG_GROUP_NAME ?? '' } },
      idlePolicy: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: Number(process.env.MICROVM_MAX_IDLE_SECONDS),
        suspendedDurationSeconds: Number(process.env.MICROVM_SUSPENDED_SECONDS),
      },
      maximumDurationInSeconds: Number(process.env.MICROVM_MAX_DURATION_SECONDS),
      clientToken: sessionId,
      runHookPayload: JSON.stringify({ gitEmail: ownerEmail, sessionId, workspaceToken }),
    }),
  );
  if (!result.microvmId || !result.endpoint) throw new Error('RunMicrovm did not return a microvmId/endpoint');
  return { resourceId: result.microvmId, endpoint: result.endpoint, state: 'PENDING' };
}

async function startEc2(sessionId: string, ownerId: string, expiresAt: number, ownerEmail?: string): Promise<StartedCompute> {
  const subnets = (process.env.EC2_SUBNET_IDS ?? '').split(',');
  // Spread sessions across the private subnets; a session has a single instance, so no balancing is needed.
  const subnetId = subnets[sessionId.charCodeAt(0) % subnets.length];
  const result = await ec2.send(
    new RunInstancesCommand({
      LaunchTemplate: { LaunchTemplateId: process.env.EC2_LAUNCH_TEMPLATE_ID, Version: '$Latest' },
      SubnetId: subnetId,
      MinCount: 1,
      MaxCount: 1,
      ClientToken: sessionId,
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'Name', Value: `${process.env.NAME_PREFIX}-${sessionId.slice(0, 8)}` },
            { Key: 'CodeServerSessions', Value: process.env.NAME_PREFIX ?? '' },
            { Key: 'SessionId', Value: sessionId },
            { Key: 'OwnerId', Value: ownerId },
            { Key: 'ExpiresAt', Value: String(expiresAt) },
            // Replaces characters EC2 refuses in instance metadata tags, which would fail the launch.
            ...(ownerEmail ? [{ Key: 'GitEmail', Value: ownerEmail.replace(/[^\w.:/=+@-]/g, '_') }] : []),
          ],
        },
      ],
    }),
  );
  const instanceId = result.Instances?.[0]?.InstanceId;
  if (!instanceId) throw new Error('RunInstances did not return an instance');
  return { resourceId: instanceId, state: 'PENDING' };
}

export async function startCompute(
  compute: Compute, sessionId: string, ownerId: string, expiresAt: number, ownerEmail?: string, workspaceToken?: string,
): Promise<StartedCompute> {
  return compute === 'ec2' ? startEc2(sessionId, ownerId, expiresAt, ownerEmail) : startMicrovm(sessionId, ownerEmail, workspaceToken);
}

/**
 * Reads the live state: idle suspends, lifetime limits and the sweeper change it outside the control plane.
 */
export async function readState(session: SessionRecord): Promise<SessionState> {
  try {
    if (session.compute === 'ec2') {
      const result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [session.resourceId] }));
      const name = result.Reservations?.[0]?.Instances?.[0]?.State?.Name;
      return (name && EC2_STATES[name]) || 'TERMINATED';
    }
    const microvm = await microvms.send(new GetMicrovmCommand({ microvmIdentifier: session.resourceId }));
    return (microvm.state as SessionState | undefined) ?? session.state;
  } catch (err) {
    // A terminated resource eventually stops being describable.
    const name = (err as Error).name;
    if (name === 'ResourceNotFoundException' || name === 'InvalidInstanceID.NotFound') return 'TERMINATED';
    throw err;
  }
}

export async function suspendCompute(session: SessionRecord): Promise<void> {
  if (session.compute === 'ec2') await ec2.send(new StopInstancesCommand({ InstanceIds: [session.resourceId] }));
  else await microvms.send(new SuspendMicrovmCommand({ microvmIdentifier: session.resourceId }));
}

export async function resumeCompute(session: SessionRecord): Promise<void> {
  if (session.compute === 'ec2') await ec2.send(new StartInstancesCommand({ InstanceIds: [session.resourceId] }));
  else await microvms.send(new ResumeMicrovmCommand({ microvmIdentifier: session.resourceId }));
}

export async function terminateCompute(session: SessionRecord): Promise<void> {
  if (session.compute === 'ec2') await ec2.send(new TerminateInstancesCommand({ InstanceIds: [session.resourceId] }));
  else await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: session.resourceId }));
}
