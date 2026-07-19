/**
 * Common S3 type definitions
 */

/**
 * S3 bucket lifecycle configuration
 *
 * Controls the number of days until transition to each storage class and
 * the number of days until deletion, independently.
 * When specifying multiple values, ensure the day counts are in ascending
 * order (validated).
 *
 * Minimum day constraints for AWS S3 storage class transitions:
 *   - S3 Standard-IA:                  minimum 30 days from S3 Standard
 *   - S3 Glacier Flexible Retrieval:   minimum 1 day from S3 Standard (90+ days recommended in practice)
 *   - S3 Glacier Deep Archive:         minimum 180 days from S3 Standard
 */
export interface S3LifecycleConfig {
  /**
   * Number of days until transition to S3 Standard-IA
   * If unspecified, no transition to S3 Standard-IA occurs.
   * AWS constraint: positive integer of 30 or more
   * @example 30
   */
  readonly standardIaDays?: number;
  /**
   * Number of days until transition to S3 Glacier Flexible Retrieval (formerly S3 Glacier)
   * If unspecified, no transition occurs.
   * @example 90
   */
  readonly glacierFlexibleDays?: number;
  /**
   * Number of days until transition to S3 Glacier Deep Archive
   * If unspecified, no transition occurs.
   * AWS constraint: positive integer of 180 or more
   * @example 180
   */
  readonly glacierDeepArchiveDays?: number;
  /**
   * Number of days until the object is deleted
   * If unspecified, no automatic deletion occurs (retained indefinitely).
   * @example 365
   */
  readonly expirationDays?: number;
}

export const defaultS3Lifecycle: S3LifecycleConfig = {
      standardIaDays: 30,
      glacierFlexibleDays: 90,
      glacierDeepArchiveDays: 540,
      expirationDays: 2675, // 7 years 4 months (7×365 + 4×30 = 2675 days)
};
