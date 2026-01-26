import { 
    SqsLambdaIntegrationParams, 
    LambdaFunctionParams,
    FirehoseS3Params
} from 'lib/types';
import { Environment, EnvironmentConfig  } from "@common/parameters/environments";

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
    readonly sqsLambdaIntegration: SqsLambdaIntegrationParams;
    readonly lambdaFunction: LambdaFunctionParams;
    readonly firehose: FirehoseS3Params;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};