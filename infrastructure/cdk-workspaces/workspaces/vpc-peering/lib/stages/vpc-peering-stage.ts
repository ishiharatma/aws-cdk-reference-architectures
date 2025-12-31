import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VpcAStack } from "lib/stacks/vpc-a-stack";
import { VpcCStack } from "lib/stacks/vpc-c-stack";
import { CrossAccountPeeringStack } from "lib/stacks/cross-account-peering-stack";
import { VpcCRoutesStack } from "lib/stacks/vpc-c-routes-stack";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from 'lib/types/vpc-peering-params';
import { params } from "parameters/environments";

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

/**
 * VPC Peering Stage
 * 
 * This stage orchestrates the deployment of:
 * 1. VPC A and VPC B in Account A with peering connection (VpcPeeringStack)
 * 2. VPC C in Account B (VpcCStack) - if configured
 * 3. Cross-account peering between VPC B and VPC C (CrossAccountPeeringStack) - if configured
 * 
 * Deployment order:
 * - Deploy to Account A first (VpcPeeringStack)
 * - Deploy to Account B (VpcCStack) - requires separate deployment with different credentials
 * - Deploy cross-account peering to Account A (CrossAccountPeeringStack)
 */
export class VpcPeeringStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    // Stack 1: VPC A and VPC B in Account A with peering
    const peeringRoleName = props.params.accountBId ? `${props.project}-${props.environment}-VpcPeeringAcceptRole` : undefined;
    const vpcAStack = new VpcAStack(this, `VpcA`, {
      project: props.project,
      environment: props.environment,
      env: {
        account: props.params.accountAId,
        region: props.params.regionA || props.env?.region,
      },
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });

    // Stack 2: VPC C in Account B (only if configured)
    // Note: This requires deployment to Account B with separate credentials
    // Use: cdk deploy --profile account-b
    if (props.params.vpcCConfig && props.params.accountBId) {
      const vpcCStack = new VpcCStack(this, `VpcC`, {
        project: props.project,
        environment: props.environment,
        env: {
          account: props.params.accountBId,
          region: props.params.regionB || props.env?.region,
        },
        terminationProtection: props.terminationProtection,
        isAutoDeleteObject: props.isAutoDeleteObject,
        params: props.params,
        peeringRoleName,
      });

      // Stack 3: Cross-account peering between VPC B and VPC C
      // This stack is deployed to Account A and uses Custom Resource to automatically
      // retrieve VPC C ID from Account B's Parameter Store
      // Note: VpcCStack must be deployed to Account B first
      if (peeringRoleName) {
        const crossAccountPeeringStack = new CrossAccountPeeringStack(this, `CrossAccountPeering`, {
          project: props.project,
          environment: props.environment,
          env: {
            account: props.params.accountAId,
            region: props.params.regionA || props.env?.region,
          },
          terminationProtection: props.terminationProtection,
          isAutoDeleteObject: props.isAutoDeleteObject,
          params: props.params,
          requestorVpc: vpcAStack.vpcB.vpc,
          requestorVpcCidr: props.params.vpcBConfig.createConfig!.cidr,
          peeringVpcCidr: props.params.vpcCConfig.createConfig!.cidr,
          peeringRoleName
        });
        // Set dependencies - ensure VPC B is deployed first
        // Note: VPC C should be deployed separately to Account B before this stack
        crossAccountPeeringStack.addDependency(vpcAStack);

        // Stack 4: VPC C Routes (Account B)
        // This stack adds routes in VPC C pointing to VPC B
        // Note: Requires the peering connection ID from CrossAccountPeeringStack
        // This stack must be deployed AFTER the peering connection is accepted
        const vpcCRoutesStack = new VpcCRoutesStack(this, `VpcCRoutes`, {
          project: props.project,
          environment: props.environment,
          env: {
            account: props.params.accountBId,
            region: props.params.regionB || props.env?.region,
          },
          params: props.params,
          vpc : vpcCStack.vpcC.vpc,
          vpcBCidr: props.params.vpcBConfig.createConfig!.cidr,
          peeringIdParamName: `/${props.project}/${props.environment}/peering/vpc-b-vpc-c/id`,
          terminationProtection: props.terminationProtection,
        });

        // Set dependencies
        vpcCRoutesStack.addDependency(crossAccountPeeringStack);
        vpcCRoutesStack.addDependency(vpcCStack);
      }
    }
  }
}

