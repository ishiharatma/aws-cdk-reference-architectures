import * as cdk from 'aws-cdk-lib';

export const defaultFirehoseS3Config = {
    dataOutputPrefix: "!{timestamp:yyyy/MM/dd/HH}/",
    errorOutputPrefix: "!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/",
    timeZone: cdk.TimeZone.ASIA_TOKYO,
    bufferingInterval: cdk.Duration.seconds(300),
    bufferingSize: cdk.Size.mebibytes(64),
};

/**
 * Firehose parameters for S3 destination
 */
export interface FirehoseS3Params {
    /**
     * S3 prefix for successfully delivered data
     * Supports dynamic partitioning with !{timestamp:...} and !{partitionKeyFromQuery:...}
     * @default "!{timestamp:yyyy/MM/dd/HH}/"
     */
    readonly dataOutputPrefix?: string;
    /**
     * S3 prefix for delivery failure records
     * @default "!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/"
     */
    readonly errorOutputPrefix?: string;
    /**
     * Timezone used for the timestamp in S3 prefixes
     * @default cdk.TimeZone.ASIA_TOKYO
     */
    readonly timeZone?: cdk.TimeZone;
    /**
     * Buffering interval before flushing to S3 (60–900 seconds)
     * @default 300 seconds
     */
    readonly bufferingInterval?: cdk.Duration;
    /**
     * Buffering size before flushing to S3 (1–128 MiB)
     * @default 64 MiB
     */
    readonly bufferingSize?: cdk.Size;
}
