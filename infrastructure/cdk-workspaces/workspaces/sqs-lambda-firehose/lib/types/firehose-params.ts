import * as cdk from 'aws-cdk-lib';

export const defaultFirehoseS3Config = {
    dataOutputPrefix: "!{timestamp:yyyy/MM/dd}/",
    errorOutputPrefix: "!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/",
    timeZone: cdk.TimeZone.ETC_UTC,
    bufferingInterval: cdk.Duration.seconds(300),
    bufferingSize: cdk.Size.mebibytes(5),
};

/**
 * Firehose parameters type for S3 destination
 */
export interface FirehoseS3Params {
    /**
     * Data Output Prefix
     * @default "!{timestamp:yyyy/MM/dd}/"
     */
    readonly dataOutputPrefix?: string;
    /**
     * Error Output Prefix
     * @default "!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/"
     */
    readonly errorOutputPrefix?: string;
    /**
     * Time Zone
     * @default cdk.TimeZone.UTC
     */
    readonly timeZone?: cdk.TimeZone;
    /**
     * Buffering Interval
     * @default 300 seconds
     */
    readonly bufferingInterval?: cdk.Duration;
    /**
     * Buffering Size
     * @default 5 MiBytes
     */
    readonly bufferingSize?: cdk.Size;
}