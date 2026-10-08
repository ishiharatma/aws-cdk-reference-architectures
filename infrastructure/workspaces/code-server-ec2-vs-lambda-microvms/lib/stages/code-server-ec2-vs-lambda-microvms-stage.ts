import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { CodeServerEc2Stack } from 'lib/stacks/code-server-ec2-stack';
import { CodeServerMicrovmsStack } from 'lib/stacks/code-server-microvms-stack';

/**
 *
 */
export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

/**
 * Two independent stacks that serve the same product (code-server) on different compute models.
 * Deploy either one alone, e.g. `cdk deploy '**\/Ec2'` or `cdk deploy '**\/Microvms'`.
 */
export class CodeServerEc2VsLambdaMicrovmsStage extends cdk.Stage {
  /**
   *
   */
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    const common = {
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    };

    new CodeServerEc2Stack(this, 'Ec2', {
      ...common,
      stackName: `${props.project}-${props.environment}-code-server-ec2`,
      description: 'code-server on EC2 behind CloudFront (always-on baseline)',
    });

    new CodeServerMicrovmsStack(this, 'Microvms', {
      ...common,
      stackName: `${props.project}-${props.environment}-code-server-microvms`,
      description: 'code-server on AWS Lambda MicroVMs (on-demand, suspend/resume)',
    });
  }
}
