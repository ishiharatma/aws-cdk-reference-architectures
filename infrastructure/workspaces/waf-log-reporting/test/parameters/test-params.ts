import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const testParams: EnvParams = {
    stackNamePrefix: 'waf-log-reporting',

    sampleWaf: {},

    cwLogsReport: {
        notificationEmail: 'test@example.com',
    },

    athenaReport: {
        notificationEmail: 'test@example.com',
    },
};

params[Environment.TEST] = testParams;
