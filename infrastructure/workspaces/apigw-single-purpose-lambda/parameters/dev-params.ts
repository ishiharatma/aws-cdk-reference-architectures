import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const devParams: EnvParams = {
  stackNamePrefix: 'apigw-single-purpose-lambda',
  region: 'ap-northeast-1',
};

params[Environment.DEVELOPMENT] = devParams;
