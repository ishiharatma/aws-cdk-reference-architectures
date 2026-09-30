import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { SecurityBaselineStack } from 'lib/stacks/security-baseline-stack';

/** Properties for {@link SecurityBaselineStage}. */
export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

/** Deploys the security baseline stack for one environment. */
export class SecurityBaselineStage extends cdk.Stage {
  /**
   * Instantiates the stack with the stage's project, environment and parameters.
   *
   * @param scope - parent construct
   * @param id - construct ID
   * @param props - stage settings
   */
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new SecurityBaselineStack(this, pascalCase(`${props.project}SecurityBaseline`), {
      stackName: `${props.project}-${props.environment}-security-baseline`,
      description: `${pascalCase(props.project)} single-account security baseline for ${props.environment}`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
