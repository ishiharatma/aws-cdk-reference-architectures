import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { DrPrimaryStack } from 'lib/stacks/dr-primary-stack';
import { DrRecoveryStack } from 'lib/stacks/dr-recovery-stack';
import { DrSecondaryStack } from 'lib/stacks/dr-secondary-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
  /** Also synthesize the pilot light recovery stack (compute in the DR region). Off in normal operation. */
  readonly includeRecoveryStack?: boolean;
}

/**
 * Stack 1 (DR region)       backup vault, warm standby API (scaled to zero), active-active API
 * Stack 2 (primary region)  tables, APIs, backup plan, DNS routing; consumes stack 1
 * Stack 3 (DR region)       pilot light compute, only with includeRecoveryStack (the drill deploys it)
 */
export class MultiRegionDrStrategiesStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    const { project, environment, params } = props;
    const account = props.env?.account;
    const common = {
      project,
      environment,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      crossRegionReferences: true,
    };

    const secondary = new DrSecondaryStack(this, pascalCase(`${project}DrSecondary`), {
      ...common,
      stackName: `${project}-${environment}-dr-secondary`,
      description: `${pascalCase(project)} multi-region DR: DR region for ${environment}`,
      env: { account, region: params.drRegion },
      params,
    });
    const primary = new DrPrimaryStack(this, pascalCase(`${project}DrPrimary`), {
      ...common,
      stackName: `${project}-${environment}-dr-primary`,
      description: `${pascalCase(project)} multi-region DR: primary region for ${environment}`,
      env: { account, region: params.primaryRegion },
      params,
      drVaultName: secondary.vaultName,
      warmStandbyHost: secondary.warmStandbyHost,
      activeActiveHost: secondary.activeActiveHost,
    });
    primary.addDependency(secondary);

    if (props.includeRecoveryStack) {
      new DrRecoveryStack(this, pascalCase(`${project}DrRecovery`), {
        stackName: `${project}-${environment}-dr-recovery`,
        description: `${pascalCase(project)} multi-region DR: pilot light recovery compute for ${environment}`,
        project,
        environment,
        env: { account, region: params.drRegion },
        isAutoDeleteObject: props.isAutoDeleteObject,
      });
    }
  }
}
