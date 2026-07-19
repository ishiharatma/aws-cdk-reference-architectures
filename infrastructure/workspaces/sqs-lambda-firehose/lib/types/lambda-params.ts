import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { time } from 'console';
import { arch } from 'os';

export const defaultLambdaConfig = {
    handler: "lambda_handler",
    runtime: lambda.Runtime.PYTHON_3_14,
    logLevel: lambda.ApplicationLogLevel.INFO,
    timeout: cdk.Duration.seconds(3),
    memorySize: 128,
    retryAttempts: 2,
    tracing: lambda.Tracing.DISABLED,
    logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
    architecture: lambda.Architecture.ARM_64,
    ephemeralStorageSize: cdk.Size.mebibytes(512),
};

/**
 * Lambda Function Parameters
 */
export interface LambdaFunctionParams {
    /**
     * Lambda Function Name Suffix
     */
    readonly functionNameSuffix?: string;

    /**
     * Description
     * @default undefined
     */
    readonly description?: string;
    
    /**
     * Runtime
     * @default lambda.Runtime.PYTHON_3_13
     */
    readonly runtime?: lambda.Runtime;
    
    /**
     * Handler
     * @default "lambda_handler"
     */
    readonly handler?: string;
    
    /**
     * Code Asset Path
     */
    readonly codeAssetPath: string;
    
    /**
     * Timeout
     * SQS visibilityTimeout is recommended to be at least 6 times this timeout
     * @default 3 seconds
     */
    readonly timeout?: cdk.Duration;
    
    /**
     * Memory Size (MB)
     * @default 128
     */
    readonly memorySize?: number;
    
    /**
     * Environment Variables
     * @default undefined
     */
    readonly environment?: Record<string, string>;
    
    /**
     * Reserved Concurrent Executions
     * @default undefined (no limit)
     */
    readonly reservedConcurrentExecutions?: number;
    
    /**
     * Retry Attempts
     * @default 2
     */
    readonly retryAttempts?: number;
    
    /**
     * Enable Lambda Insights
     * @default undefined
     */
    readonly insightsVersion?: lambda.LambdaInsightsVersion;
    
    /**
     * Enable X-Ray Tracing
     * @default Tracing.DISABLED
     */
    readonly tracing?: lambda.Tracing;
    readonly logLevel?: lambda.ApplicationLogLevel;
    /**
     * Lambda Layers
     * @default undefined
     */
    layers?: lambda.ILayerVersion[];
    
    /**
     * VPC Configuration
     * @default undefined (run outside VPC)
     */
    vpc?: cdk.aws_ec2.IVpc;
    
    /**
     * VPC Subnet Selection
     * @default undefined
     */
    vpcSubnets?: cdk.aws_ec2.SubnetSelection;
    
    /**
     * Security Groups
     * @default undefined
     */
    securityGroups?: cdk.aws_ec2.ISecurityGroup[];
    
    /**
     * Log Retention Period
     * @default logs.RetentionDays.ONE_WEEK
     */
    readonly logRetention?: cdk.aws_logs.RetentionDays;
    
    /**
     * Dead Letter Queue
     * @default undefined
     */
    deadLetterQueue?: cdk.aws_sqs.IQueue;
    
    /**
     * Enable Dead Letter Queue
     * @default false
     */
    readonly deadLetterQueueEnabled?: boolean;
    
    /**
     * Maximum Event Age (seconds)
     * @default 21600 (6 hours)
     */
    readonly maxEventAge?: cdk.Duration;
    
    /**
     * Architecture
     * @default Architecture.ARM_64
     */
    readonly architecture?: lambda.Architecture;
    
    /**
     * Ephemeral Storage Size (MB)
     * @default 512
     */
    readonly ephemeralStorageSize?: cdk.Size;
    
    /**
     * Provisioned Concurrent Executions
     * @default undefined
     */
    readonly provisionedConcurrentExecutions?: number;
    
    /**
     * Enable Function URL
     * @default false
     */
    readonly functionUrlEnabled?: boolean;
    
    /**
     * Function URL Authentication Type
     * @default FunctionUrlAuthType.AWS_IAM
     */
    readonly functionUrlAuthType?: lambda.FunctionUrlAuthType;
}
