import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const devParams: EnvParams = {
  stackNamePrefix: 'apigw-lambdalith',
  region: 'ap-northeast-1',
};

params[Environment.DEVELOPMENT] = devParams;
