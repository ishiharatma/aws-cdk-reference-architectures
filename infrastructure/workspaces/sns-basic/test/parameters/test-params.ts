import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const testParams: EnvParams = {
    stackNamePrefix: 'sns-basic',

    snsBasic: {
        notificationEmail: 'test@example.com',
    },
};

params[Environment.TEST] = testParams;
