import { AdminDisableUserCommand, AdminGetUserCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { terminateCompute } from './lib/compute';
import { listOwnedSessions, updateSessionState } from './lib/session-store';

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID ?? '';

/**
 * Offboarding, invoked by an operator: aws lambda invoke --payload '{"username":"..."}'
 *
 * Disabling a Cognito user alone leaves running sessions and issued endpoint tokens working, so this
 * also ends every session of the user. A terminated MicroVM takes its endpoint token with it.
 */
export async function handler(event: { username?: string }): Promise<{ username: string; ended: string[]; failed: string[] }> {
  const username = event.username;
  if (!username) throw new Error('username is required');

  const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
  const ownerId = user.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
  if (!ownerId) throw new Error('The user has no sub attribute');

  await cognito.send(new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
  await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: USER_POOL_ID, Username: username }));

  const sessions = (await listOwnedSessions(ownerId)).filter((s) => s.state !== 'TERMINATED');
  const ended: string[] = [];
  const failed: string[] = [];
  await Promise.all(sessions.map(async (session) => {
    try {
      await terminateCompute(session);
      await updateSessionState(session.sessionId, 'TERMINATING');
      ended.push(session.sessionId);
    } catch (err) {
      console.error(`Could not end session ${session.sessionId}`, err);
      failed.push(session.sessionId);
    }
  }));
  console.log(JSON.stringify({ username, ended, failed }));
  return { username, ended, failed };
}
