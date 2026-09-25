import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { claimsOf, groupsOf, json } from './utils/http';

/** GET /me — any signed-in user (ID token). Echoes what the authorizer verified. */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const claims = claimsOf(event);
  return json(200, {
    sub: claims.sub,
    email: claims.email,
    username: claims['cognito:username'],
    groups: groupsOf(claims),
    tokenUse: claims.token_use,
  });
};
