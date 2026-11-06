import { readState } from '../../src/control-plane/lib/compute';
import type { SessionRecord } from '../../src/control-plane/lib/session-store';

const record = (compute: SessionRecord['compute'], state: SessionRecord['state']): SessionRecord => ({
  sessionId: 's',
  ownerId: 'o',
  compute,
  resourceId: 'i-0123456789abcdef0',
  state,
  createdAt: '',
  updatedAt: '',
  expiresAt: 0,
});

describe('readState', () => {
  test('an EC2 record left after the EC2 stack is removed reads as terminated, without calling EC2', async () => {
    delete process.env.EC2_LAUNCH_TEMPLATE_ID;
    await expect(readState(record('ec2', 'TERMINATING'))).resolves.toBe('TERMINATED');
    await expect(readState(record('ec2', 'RUNNING'))).resolves.toBe('TERMINATED');
  });
});
