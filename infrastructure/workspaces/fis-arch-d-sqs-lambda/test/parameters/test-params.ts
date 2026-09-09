import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const testParams: EnvParams = {
    region: 'ap-northeast-1',
    tags: {},
};

params[Environment.TEST] = testParams;
