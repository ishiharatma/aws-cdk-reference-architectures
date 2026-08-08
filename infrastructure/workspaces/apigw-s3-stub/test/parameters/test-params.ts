import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const testParams: EnvParams = {
    stackNamePrefix: 'apigw-s3-stub',
};

params[Environment.TEST] = testParams;
