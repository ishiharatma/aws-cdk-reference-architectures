import * as path from 'path';
import { execFileSync } from 'child_process';
import * as cdk from 'aws-cdk-lib';

/**
 * Local esbuild bundling shared by the L1 and L2 stacks.
 *
 * Bundles `entry` (relative to `sourceDir`) into a single `index.js` at the root of the
 * asset, which is the default entry point of the Web Functions Node.js runtime.
 * Docker bundling is intentionally not supported.
 */
export function esbuildBundling(sourceDir: string, entry: string): cdk.BundlingOptions {
  return {
    image: cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/node:24-alpine'),
    command: ['sh', '-c', 'echo "Docker bundling is not supported; install esbuild locally" && exit 1'],
    local: {
      tryBundle(outputDir: string): boolean {
        execFileSync(
          'npx',
          [
            'esbuild',
            path.join(sourceDir, entry),
            '--bundle',
            '--platform=node',
            '--target=node24',
            '--format=cjs',
            `--outfile=${path.join(outputDir, 'index.js')}`,
            '--log-level=warning',
          ],
          { stdio: 'inherit' },
        );
        return true;
      },
    },
  };
}
