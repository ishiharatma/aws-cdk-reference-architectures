/* eslint-disable @typescript-eslint/no-explicit-any */
import { Template } from 'aws-cdk-lib/assertions';
import { buildStack } from '../helpers';
import '../parameters';

/**
 * Snapshot tests: detect unintended template changes and resource count drift (cost impact).
 * Detailed property checks live in test/unit.
 */
const variants: Record<string, Parameters<typeof buildStack>[0]> = {
  'internet egress': {},
  'firewall egress': { network: { egressMode: 'firewall', ingressMode: 'none', allowedDomains: ['api.anthropic.com', '.amazonaws.com'] } },
};

describe.each(Object.entries(variants))('Stack Snapshot Tests (%s)', (_name, overrides) => {
  const template = Template.fromStack(buildStack(overrides));

  test('Complete CloudFormation template snapshot', () => {
    const json = template.toJSON();
    // Asset hashes change with unrelated file edits; keep the structure, drop the volatile parts.
    const text = JSON.stringify(json).replace(/[0-9a-f]{64}\.zip/g, 'ASSET.zip');
    expect(JSON.parse(text)).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    const counts: Record<string, number> = {};
    Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
      counts[resource.Type] = (counts[resource.Type] || 0) + 1;
    });
    expect(counts).toMatchSnapshot();
  });
});
