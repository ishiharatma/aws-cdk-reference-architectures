import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

const cognito = new CognitoIdentityProviderClient({});

/**
 * An ID token stays valid after its user is disabled, so the routes that start compute or hand out a
 * way in also ask Cognito directly.
 */
export async function isUserEnabled(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<boolean> {
  const username = event.requestContext.authorizer?.jwt?.claims?.['cognito:username'];
  if (typeof username !== 'string') return false;
  const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: process.env.USER_POOL_ID, Username: username }));
  return user.Enabled === true;
}
