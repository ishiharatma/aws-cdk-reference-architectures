import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as adminHandler } from '../../src/handlers/admin';
import { handler as meHandler } from '../../src/handlers/me';
import { groupsOf } from '../../src/handlers/utils/http';

const eventWith = (claims: Record<string, string>): APIGatewayProxyEvent =>
  ({ requestContext: { authorizer: { claims } } }) as unknown as APIGatewayProxyEvent;

describe('groupsOf', () => {
  test.each([
    [undefined, []],
    ['admin', ['admin']],
    ['[admin member]', ['admin', 'member']],
    ['admin,member', ['admin', 'member']],
  ])('%s -> %j', (raw, expected) => {
    expect(groupsOf(raw === undefined ? {} : { 'cognito:groups': raw })).toEqual(expected);
  });
});

describe('admin handler', () => {
  test('refuses callers outside the admin group', async () => {
    expect((await adminHandler(eventWith({ 'cognito:groups': 'member' }))).statusCode).toBe(403);
    expect((await adminHandler(eventWith({}))).statusCode).toBe(403);
  });

  test('admits members of admin, including when in several groups', async () => {
    expect((await adminHandler(eventWith({ 'cognito:groups': '[member admin]', email: 'a@example.com' }))).statusCode).toBe(200);
  });
});

describe('me handler', () => {
  test('echoes the verified claims', async () => {
    const res = await meHandler(eventWith({ sub: 's1', email: 'a@example.com', 'cognito:username': 'u1', token_use: 'id', 'cognito:groups': 'member' }));
    expect(JSON.parse(res.body)).toEqual({ sub: 's1', email: 'a@example.com', username: 'u1', groups: ['member'], tokenUse: 'id' });
  });
});
