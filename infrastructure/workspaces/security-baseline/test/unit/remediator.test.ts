/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsffFinding, Clients, Remediator, RemediatorConfig, bucketNameOf, classify, controlIdOf, resourceIdOf } from '../../src/remediation/remediator';

const config: RemediatorConfig = {
  mode: 'enforce',
  s3ControlIds: ['S3.8'],
  sgControlIds: ['EC2.53'],
  remoteAdminPorts: [22, 3389],
  guardDutyMinSeverity: 'HIGH',
  trustedProducts: ['Security Hub', 'GuardDuty', 'Default'],
  skipTagKey: 'skip',
  namePrefix: 'p',
  topicArn: 'arn:aws:sns:ap-northeast-1:1:t',
};

const finding = (over: Partial<AsffFinding> & Record<string, any>): AsffFinding => ({
  Id: 'f1', ProductArn: 'arn:p', ProductName: 'Security Hub', Title: 'title',
  Compliance: { Status: 'FAILED', SecurityControlId: 'S3.8' },
  Resources: [{ Type: 'AwsS3Bucket', Id: 'arn:aws:s3:::my-bucket' }],
  ...over,
});

/** Fake clients that record every command by its constructor name and answer from a table. */
const fakes = (answers: Record<string, any> = {}) => {
  const calls: { name: string; input: any }[] = [];
  const send = jest.fn(async (command: any) => {
    const name = command.constructor.name;
    calls.push({ name, input: command.input });
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(command.input) : (answer ?? {});
  });
  const clients: Clients = { s3: { send } as any, ec2: { send } as any, securityHub: { send } as any, sns: { send } as any };
  const call = (name: string) => {
    const found = calls.find((c) => c.name === name);
    if (!found) throw new Error(`${name} was not sent`);
    return found.input;
  };
  return { clients, calls, call, names: () => calls.map((c) => c.name) };
};

describe('helpers', () => {
  test('control id comes from either field, bucket name and resource id from ARNs', () => {
    expect(controlIdOf(finding({ Compliance: { Status: 'FAILED', SecurityControlId: 'S3.8' } }))).toBe('S3.8');
    expect(controlIdOf(finding({ Compliance: undefined, ProductFields: { ControlId: 'EC2.53' } }))).toBe('EC2.53');
    expect(bucketNameOf('arn:aws:s3:::my-bucket')).toBe('my-bucket');
    expect(resourceIdOf('arn:aws:ec2:ap-northeast-1:1:security-group/sg-1')).toBe('sg-1');
    expect(resourceIdOf('i-1')).toBe('i-1');
  });
});

describe('classify', () => {
  test('S3 and security group control findings map to their remediations', () => {
    expect(classify(finding({}), config)).toEqual({ kind: 'block-s3-public-access', resourceId: 'my-bucket' });
    expect(classify(finding({
      Compliance: { Status: 'FAILED', SecurityControlId: 'EC2.53' },
      Resources: [{ Type: 'AwsEc2SecurityGroup', Id: 'arn:aws:ec2:r:1:security-group/sg-9' }],
    }), config)).toEqual({ kind: 'revoke-open-admin-ports', resourceId: 'sg-9' });
  });

  test('a GuardDuty finding on an instance at or above the severity quarantines it', () => {
    const gd = (label: string) => finding({
      ProductName: 'GuardDuty', Compliance: undefined, Severity: { Label: label },
      Resources: [{ Type: 'AwsEc2Instance', Id: 'arn:aws:ec2:r:1:instance/i-1' }],
    });
    expect(classify(gd('HIGH'), config)).toEqual({ kind: 'quarantine-instance', resourceId: 'i-1' });
    expect(classify(gd('CRITICAL'), config)?.kind).toBe('quarantine-instance');
    expect(classify(gd('MEDIUM'), config)).toBeUndefined();
  });

  test.each([
    ['an untrusted product', { ProductName: 'SomethingElse' }],
    ['a passed control', { Compliance: { Status: 'PASSED', SecurityControlId: 'S3.8' } }],
    ['a control without a remediation', { Compliance: { Status: 'FAILED', SecurityControlId: 'S3.1' } }],
    ['the right control on the wrong resource type', { Resources: [{ Type: 'AwsEc2SecurityGroup', Id: 'sg-1' }] }],
    ['a finding without resources', { Resources: [] }],
  ])('%s is ignored', (_name, over) => {
    expect(classify(finding(over as any), config)).toBeUndefined();
  });

  test('imported findings are ignored when Default is not a trusted product', () => {
    expect(classify(finding({ ProductName: 'Default' }), { ...config, trustedProducts: ['Security Hub', 'GuardDuty'] })).toBeUndefined();
  });
});

describe('S3 public access', () => {
  test('enforce blocks all four settings, resolves the finding and tells the topic', async () => {
    const f = fakes();
    const results = await new Remediator(f.clients, config).handle([finding({})]);
    expect(results).toEqual([expect.objectContaining({ kind: 'block-s3-public-access', resource: 'my-bucket', outcome: 'remediated' })]);
    expect(f.call('PutPublicAccessBlockCommand')).toEqual({
      Bucket: 'my-bucket',
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
    });
    const update = f.call('BatchUpdateFindingsCommand');
    expect(update.Workflow).toEqual({ Status: 'RESOLVED' });
    expect(update.Note.Text).toContain('remediated');
    expect(f.names()).toContain('PublishCommand');
  });

  test('dry-run changes nothing and only adds a note', async () => {
    const f = fakes();
    const [r] = await new Remediator(f.clients, { ...config, mode: 'dry-run' }).handle([finding({})]);
    expect(r.outcome).toBe('dry-run');
    expect(f.names()).not.toContain('PutPublicAccessBlockCommand');
    expect(f.call('BatchUpdateFindingsCommand').Workflow).toBeUndefined();
  });

  test('a bucket with the skip tag is left alone', async () => {
    const f = fakes({ GetBucketTaggingCommand: { TagSet: [{ Key: 'skip', Value: 'true' }] } });
    const [r] = await new Remediator(f.clients, config).handle([finding({})]);
    expect(r.outcome).toBe('skipped');
    expect(f.names()).not.toContain('PutPublicAccessBlockCommand');
  });
});

describe('open SSH and RDP', () => {
  const sgFinding = finding({
    Compliance: { Status: 'FAILED', SecurityControlId: 'EC2.53' },
    Resources: [{ Type: 'AwsEc2SecurityGroup', Id: 'arn:aws:ec2:r:1:security-group/sg-1' }],
  });
  const group = {
    SecurityGroups: [{
      GroupId: 'sg-1',
      IpPermissions: [
        { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }, { CidrIp: '10.0.0.0/8' }], Ipv6Ranges: [{ CidrIpv6: '::/0' }] },
        { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
        { IpProtocol: 'tcp', FromPort: 8000, ToPort: 9000, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
      ],
    }],
  };

  test('only the open ranges on the admin ports are revoked; other rules and sources stay', async () => {
    const f = fakes({ DescribeSecurityGroupsCommand: group });
    const [r] = await new Remediator(f.clients, config).handle([sgFinding]);
    expect(r.outcome).toBe('remediated');
    const revoke = f.call('RevokeSecurityGroupIngressCommand');
    expect(revoke.IpPermissions).toEqual([{
      IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }], Ipv6Ranges: [{ CidrIpv6: '::/0' }],
    }]);
  });

  test('an all-traffic rule open to the internet is revoked too', async () => {
    const f = fakes({ DescribeSecurityGroupsCommand: { SecurityGroups: [{ GroupId: 'sg-1', IpPermissions: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }] } });
    const [r] = await new Remediator(f.clients, config).handle([sgFinding]);
    expect(r.outcome).toBe('remediated');
  });

  test('nothing to revoke, dry-run and the skip tag all leave the group untouched', async () => {
    const closed = fakes({ DescribeSecurityGroupsCommand: { SecurityGroups: [{ GroupId: 'sg-1', IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '10.0.0.0/8' }] }] }] } });
    expect((await new Remediator(closed.clients, config).handle([sgFinding]))[0].outcome).toBe('skipped');
    const dry = fakes({ DescribeSecurityGroupsCommand: group });
    expect((await new Remediator(dry.clients, { ...config, mode: 'dry-run' }).handle([sgFinding]))[0].outcome).toBe('dry-run');
    const tagged = fakes({ DescribeSecurityGroupsCommand: { SecurityGroups: [{ ...group.SecurityGroups[0], Tags: [{ Key: 'skip', Value: 'true' }] }] } });
    expect((await new Remediator(tagged.clients, config).handle([sgFinding]))[0].outcome).toBe('skipped');
    [closed, dry, tagged].forEach((f) => expect(f.names()).not.toContain('RevokeSecurityGroupIngressCommand'));
  });
});

describe('compromised instance', () => {
  const gd = finding({
    ProductName: 'GuardDuty', Compliance: undefined, Severity: { Label: 'HIGH' },
    Resources: [{ Type: 'AwsEc2Instance', Id: 'arn:aws:ec2:r:1:instance/i-1' }],
  });
  const instance = { Reservations: [{ Instances: [{ InstanceId: 'i-1', VpcId: 'vpc-1', SecurityGroups: [{ GroupId: 'sg-a' }, { GroupId: 'sg-b' }], Tags: [] }] }] };

  test('creates an empty quarantine group, keeps the original groups in a tag and swaps them', async () => {
    const f = fakes({
      DescribeInstancesCommand: instance,
      DescribeSecurityGroupsCommand: { SecurityGroups: [] },
      CreateSecurityGroupCommand: { GroupId: 'sg-q' },
    });
    const [r] = await new Remediator(f.clients, config).handle([gd]);
    expect(r.outcome).toBe('remediated');
    expect(f.names().filter((n) => ['CreateSecurityGroupCommand', 'RevokeSecurityGroupEgressCommand', 'CreateTagsCommand', 'ModifyInstanceAttributeCommand'].includes(n)))
      .toEqual(['CreateSecurityGroupCommand', 'RevokeSecurityGroupEgressCommand', 'CreateTagsCommand', 'ModifyInstanceAttributeCommand']);
    expect(f.call('ModifyInstanceAttributeCommand')).toEqual({ InstanceId: 'i-1', Groups: ['sg-q'] });
    expect(JSON.stringify(f.call('CreateTagsCommand'))).toContain('sg-a,sg-b');
  });

  test('reuses the quarantine group of the VPC and does not repeat itself', async () => {
    const reuse = fakes({ DescribeInstancesCommand: instance, DescribeSecurityGroupsCommand: { SecurityGroups: [{ GroupId: 'sg-q' }] } });
    await new Remediator(reuse.clients, config).handle([gd]);
    expect(reuse.names()).not.toContain('CreateSecurityGroupCommand');
    const already = fakes({
      DescribeInstancesCommand: { Reservations: [{ Instances: [{ VpcId: 'vpc-1', SecurityGroups: [{ GroupId: 'sg-q' }] }] }] },
      DescribeSecurityGroupsCommand: { SecurityGroups: [{ GroupId: 'sg-q' }] },
    });
    expect((await new Remediator(already.clients, config).handle([gd]))[0].detail).toBe('already quarantined');
  });

  test('a sample finding for an instance that does not exist is skipped, not failed', async () => {
    const f = fakes({ DescribeInstancesCommand: new Error('InvalidInstanceID.NotFound') });
    const [r] = await new Remediator(f.clients, config).handle([gd]);
    expect(r.outcome).toBe('skipped');
  });

  test('dry-run and the skip tag leave the instance untouched', async () => {
    const dry = fakes({ DescribeInstancesCommand: instance, DescribeSecurityGroupsCommand: { SecurityGroups: [] } });
    expect((await new Remediator(dry.clients, { ...config, mode: 'dry-run' }).handle([gd]))[0].outcome).toBe('dry-run');
    const tagged = fakes({ DescribeInstancesCommand: { Reservations: [{ Instances: [{ VpcId: 'v', SecurityGroups: [], Tags: [{ Key: 'skip', Value: 'true' }] }] }] } });
    expect((await new Remediator(tagged.clients, config).handle([gd]))[0].outcome).toBe('skipped');
    [dry, tagged].forEach((f) => expect(f.names()).not.toContain('ModifyInstanceAttributeCommand'));
  });
});

describe('resilience', () => {
  test('a failure in the write-back does not stop the next finding', async () => {
    const f = fakes({ BatchUpdateFindingsCommand: new Error('throttled'), PublishCommand: new Error('kms') });
    const results = await new Remediator(f.clients, config).handle([finding({ Id: 'a' }), finding({ Id: 'b' })]);
    expect(results).toHaveLength(2);
  });

  test('without a topic nothing is published', async () => {
    const f = fakes();
    await new Remediator(f.clients, { ...config, topicArn: undefined }).handle([finding({})]);
    expect(f.names()).not.toContain('PublishCommand');
  });
});
