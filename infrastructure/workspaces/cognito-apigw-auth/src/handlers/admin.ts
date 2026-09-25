import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { claimsOf, groupsOf, json } from './utils/http';

/**
 * GET /admin — members of the `admin` group only.
 *
 * API Gateway's Cognito authorizer checks scopes, not groups, so group membership (the
 * `cognito:groups` claim of the ID token) is enforced here, on claims the authorizer already verified.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const claims = claimsOf(event);
  if (!groupsOf(claims).includes('admin')) {
    return json(403, { message: 'Requires membership of the admin group' });
  }
  return json(200, { message: 'Welcome, admin', email: claims.email });
};
