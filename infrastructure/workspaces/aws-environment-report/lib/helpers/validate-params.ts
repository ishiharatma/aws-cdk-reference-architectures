import { EnvParams } from 'parameters/environments';

/** Region every deployment must collect from (global resource types live there in AWS Config). */
export const MANDATORY_REGION = 'us-east-1';

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/**
 * Fails synth on parameter mistakes that would otherwise only show up as an
 * incomplete report weeks later.
 */
export function validateParams(params: EnvParams): void {
  const regions = params.target.regions;
  if (regions.length === 0) {
    throw new Error('target.regions must not be empty');
  }
  const invalid = regions.filter((r) => !REGION_PATTERN.test(r));
  if (invalid.length > 0) {
    throw new Error(`target.regions contains invalid region names: ${invalid.join(', ')}`);
  }
  if (new Set(regions).size !== regions.length) {
    throw new Error('target.regions contains duplicates');
  }
  if (!regions.includes(MANDATORY_REGION)) {
    throw new Error(
      `target.regions must include ${MANDATORY_REGION}: AWS Config records global resource types (IAM, CloudFront, Route 53) there`
    );
  }

  const deadline = params.schedule.finalizeDeadlineDay;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > 28) {
    throw new Error('schedule.finalizeDeadlineDay must be an integer between 1 and 28');
  }

  if (params.cur) {
    const { bucketName, prefix, exportName } = params.cur;
    if (!bucketName || !exportName) {
      throw new Error('cur.bucketName and cur.exportName are required when cur is set');
    }
    if (prefix.startsWith('/') || prefix.endsWith('/')) {
      throw new Error('cur.prefix must not start or end with "/"');
    }
  }

  if (params.security.maxFindingsPerSource < 1) {
    throw new Error('security.maxFindingsPerSource must be at least 1');
  }
}
