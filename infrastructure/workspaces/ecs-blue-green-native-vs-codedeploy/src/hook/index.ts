import { CodeDeployClient, PutLifecycleEventHookExecutionStatusCommand } from '@aws-sdk/client-codedeploy';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/**
 * Sample deployment lifecycle hook for both blue/green flavours.
 *
 * It waits `HOOK_DELAY_SECONDS` (a window in which the new version answers on the test listener while production still
 * serves the old one), then answers with the verdict held in an SSM parameter (`pass` or `fail`), which is how the check
 * script makes a deployment fail on purpose. Each flavor has its own parameter, so the two can be driven at the same time.
 *
 *   ECS native     the event carries `executionDetails`; the function RETURNS `{ hookStatus }`
 *   CodeDeploy     the event carries `DeploymentId` and `LifecycleEventHookExecutionId`; the function REPORTS the status with
 *                  PutLifecycleEventHookExecutionStatus
 */
export interface NativeHookEvent {
  executionDetails?: Record<string, unknown>;
  lifecycleStage?: string;
}
export interface CodeDeployHookEvent {
  DeploymentId: string;
  LifecycleEventHookExecutionId: string;
}
export type HookEvent = NativeHookEvent | CodeDeployHookEvent;

const ssm = new SSMClient({});
const codedeploy = new CodeDeployClient({});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `pass` unless the parameter of this flavor says `fail`. */
export const verdict = async (flavor: 'native' | 'codedeploy'): Promise<'SUCCEEDED' | 'FAILED'> => {
  const name = flavor === 'native' ? process.env.VERDICT_PARAMETER_NATIVE : process.env.VERDICT_PARAMETER_CODEDEPLOY;
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  return res.Parameter?.Value === 'fail' ? 'FAILED' : 'SUCCEEDED';
};

export const handler = async (event: HookEvent) => {
  console.log(JSON.stringify({ message: 'hook invoked', event }));
  await sleep(Number(process.env.HOOK_DELAY_SECONDS ?? '0') * 1000);
  const flavor = 'DeploymentId' in event ? 'codedeploy' : 'native';
  const status = await verdict(flavor);
  if ('DeploymentId' in event) {
    await codedeploy.send(new PutLifecycleEventHookExecutionStatusCommand({
      deploymentId: event.DeploymentId,
      lifecycleEventHookExecutionId: event.LifecycleEventHookExecutionId,
      status: status === 'SUCCEEDED' ? 'Succeeded' : 'Failed',
    }));
    return { reported: status };
  }
  return { hookStatus: status, reason: status === 'FAILED' ? 'the verdict parameter says fail' : undefined };
};
