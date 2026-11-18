/* eslint-disable @typescript-eslint/no-explicit-any */
import { buildStage, templates } from '../helpers/stage';

/**
 * Snapshot tests: detect unintended template changes and resource count changes per stack.
 * Detailed property checks live in test/unit/.
 */
describe('Stack Snapshot Tests', () => {
  const stacks = templates(buildStage());

  for (const [name, template] of Object.entries(stacks)) {
    describe(name, () => {
      test('Complete CloudFormation template snapshot', () => {
        expect(template.toJSON()).toMatchSnapshot();
      });

      test('Resource types and counts', () => {
        const resourceCounts: Record<string, number> = {};
        Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
          resourceCounts[resource.Type] = (resourceCounts[resource.Type] || 0) + 1;
        });
        expect(resourceCounts).toMatchSnapshot();
      });
    });
  }
});
