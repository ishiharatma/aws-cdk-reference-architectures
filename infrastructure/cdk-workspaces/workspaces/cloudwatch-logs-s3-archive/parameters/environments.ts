import {
    FirehoseS3Params,
    LogGroupArchiveParams,
    LifecycleArchiveParams,
    ExistingLogGroupParams,
} from 'lib/types';
import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type for cloudwatch-logs-s3-archive
 */
export interface EnvParams extends EnvironmentConfig {
    /** Firehose delivery stream configuration */
    readonly firehose: FirehoseS3Params;
    /** Log group settings for Stack 1 (Basic) and Stack 2 (Lifecycle) */
    readonly logGroup: LogGroupArchiveParams;
    /** Lifecycle rules for Stack 2 (Lifecycle). Falls back to defaults if omitted. */
    readonly lifecycle?: LifecycleArchiveParams;
    /** Existing log group to archive in Stack 3 (Existing) */
    readonly existingLogGroup: ExistingLogGroupParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
