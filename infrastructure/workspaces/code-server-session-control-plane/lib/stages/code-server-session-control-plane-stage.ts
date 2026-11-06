import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { BrowserAccessStack } from 'lib/stacks/browser-access-stack';
import { CodeCommitStack } from 'lib/stacks/code-commit-stack';
import { ControlPlaneStack } from 'lib/stacks/control-plane-stack';
import { Ec2ComputeStack } from 'lib/stacks/ec2-compute-stack';
import { MicrovmComputeStack } from 'lib/stacks/microvm-compute-stack';
import { PrivateNetworkStack } from 'lib/stacks/private-network-stack';

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
 * One control plane over two compute types. The EC2 stack (`params.ec2`) and the browser access stack
 * (`params.browserAccess`) are optional, so a MicroVM-only deployment has no NAT Gateway or CloudFront.
 */
export class CodeServerSessionControlPlaneStage extends cdk.Stage {
  /**
   *
   */
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    const { project, environment, params, isAutoDeleteObject } = props;
    const common = { project, environment, params, env: props.env, terminationProtection: props.terminationProtection };
    const stackName = (suffix: string): string => `${project}-${environment}-code-server-sessions-${suffix}`;

    const managedRepositoryNames = params.codeCommit?.managedRepositoryNames ?? [];
    if (managedRepositoryNames.length > 0) {
      new CodeCommitStack(this, 'CodeCommit', {
        env: props.env,
        terminationProtection: props.terminationProtection,
        isAutoDeleteObject,
        repositoryNames: managedRepositoryNames,
        stackName: stackName('code-commit'),
        description: 'CodeCommit repositories owned by the code-server sessions application',
      });
    }

    const isPrivate = params.microvm.egress === 'private';
    if (isPrivate && params.ec2) {
      throw new Error("microvm.egress 'private' cannot be combined with ec2: EC2 setup downloads from the internet, so its sessions would have a route out");
    }
    const privateNetwork = isPrivate
      ? new PrivateNetworkStack(this, 'PrivateNetwork', {
          env: props.env,
          terminationProtection: props.terminationProtection,
          namePrefix: `${project}-${environment}-code-server-sessions`,
          codeCommit: params.codeCommit,
          stackName: stackName('private-network'),
          description: 'VPC endpoints, DNS firewall and package mirror for sessions with no route out',
        })
      : undefined;

    const microvm = new MicrovmComputeStack(this, 'Microvm', {
      ...common,
      isAutoDeleteObject,
      stackName: stackName('microvm'),
      description: 'code-server MicroVM image and roles',
    });

    const ec2 = params.ec2
      ? new Ec2ComputeStack(this, 'Ec2', {
          ...common,
          stackName: stackName('ec2'),
          description: 'Private-subnet launch template for per-session code-server instances',
        })
      : undefined;

    const controlPlane = new ControlPlaneStack(this, 'ControlPlane', {
      ...common,
      isAutoDeleteObject,
      microvm,
      ec2,
      egressConnectorArn: privateNetwork?.connectorArn,
      stackName: stackName('control-plane'),
      description: 'Cognito-authenticated code-server session control plane',
    });

    if (params.browserAccess ?? true) {
      new BrowserAccessStack(this, 'BrowserAccess', {
        project,
        environment,
        env: props.env,
        terminationProtection: props.terminationProtection,
        httpApi: controlPlane.httpApi,
        apiStageName: controlPlane.stageName,
        stackName: stackName('browser-access'),
        description: 'CloudFront and Lambda@Edge browser access to MicroVM sessions',
      });
    }
  }
}
