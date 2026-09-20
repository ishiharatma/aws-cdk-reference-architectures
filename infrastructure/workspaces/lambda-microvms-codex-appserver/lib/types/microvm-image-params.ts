/**
 * Configuration for the `AWS::Lambda::MicrovmImage` that packages
 * `codex app-server` (see src/microvm-image/Dockerfile).
 */
export interface MicrovmImageParams {
  /**
   * Unique name for the MicroVM image within the account.
   * @default `${namePrefix}-codex-image`
   */
  readonly name?: string;

  /**
   * ARN of the AWS-managed base MicroVM image to build on top of.
   * Discover candidates with the `ListManagedMicrovmImages` API
   * (`aws lambda-microvms list-managed-microvm-images`). No safe default:
   * must be supplied per account/Region.
   */
  readonly baseImageArn: string;

  /**
   * Specific version of the base MicroVM image referenced by
   * {@link baseImageArn}. No safe default.
   */
  readonly baseImageVersion: string;

  /**
   * Minimum memory, in MiB, a MicroVM launched from this image requires.
   * @default 1024
   */
  readonly minimumMemoryInMiB?: number;

  /**
   * CPU architecture the image is built for (CloudFormation enum value).
   * @default 'ARM_64'
   */
  readonly architecture?: string;

  /**
   * Additional OS-level capabilities requested for the image.
   * @default []
   */
  readonly additionalOsCapabilities?: string[];
}

export const defaultMicrovmImageConfig: Required<
  Pick<MicrovmImageParams, 'minimumMemoryInMiB' | 'architecture' | 'additionalOsCapabilities'>
> = {
  minimumMemoryInMiB: 1024,
  architecture: 'ARM_64',
  additionalOsCapabilities: [],
};
