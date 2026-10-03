/* eslint-disable @typescript-eslint/no-explicit-any */
import { Template } from 'aws-cdk-lib/assertions';
import { makeStacks } from '../helpers/make-stacks';

/**
 * Snapshot tests for FIS chaos scenario I stacks.
 * Run `npm run test:snapshot:update` when intentional changes are made.
 */
describe('FIS Chaos Scenario I Stack Snapshots', () => {
    const { baseStack, probeStack, fisStack } = makeStacks('Snap');

    const countTypes = (template: Template) => {
        const counts: Record<string, number> = {};
        Object.values(template.toJSON().Resources || {}).forEach((r: any) => {
            counts[r.Type] = (counts[r.Type] || 0) + 1;
        });
        return counts;
    };

    describe.each([
        ['BaseStack', baseStack],
        ['ProbeStack', probeStack],
        ['FisStack', fisStack],
    ])('%s', (_name, stack) => {
        const template = Template.fromStack(stack);

        test('Complete CloudFormation template snapshot', () => {
            const json = template.toJSON();
            // Asset hashes change with the bundled Lambda code; keep the snapshot stable.
            const normalized = JSON.parse(
                JSON.stringify(json).replace(/[0-9a-f]{64}\.zip/g, 'ASSET_HASH.zip'),
            );
            expect(normalized).toMatchSnapshot();
        });

        test('Resource types and counts', () => {
            expect(countTypes(template)).toMatchSnapshot();
        });
    });
});
