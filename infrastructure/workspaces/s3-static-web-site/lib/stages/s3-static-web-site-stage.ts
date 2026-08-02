import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from "parameters/environments";
import * as path from 'path';
import { S3StaticWebSiteStack } from 'lib/stacks/s3-static-web-site-stack';

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
    /**
     * List of Ipv4 addresses to allow bucket access from. If omitted, no Ipv4 allowlist will be applied.
     * @example ['192.168.0.1']
     */
    readonly allowedIps?: string[];
    /**
     * List of Ipv6 addresses to allow bucket access from. If omitted, no Ipv6 allowlist will be applied.
     * @example ['2001:db8::1']
     */
    readonly allowedIpv6s?: string[];
}

export class S3StaticWebSiteStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new S3StaticWebSiteStack(this, pascalCase(`${props.project}S3StaticWebSite`), {
      project: props.project,
      description: `${pascalCase(props.project)} S3 Static Website Stack for ${props.environment}`,
      environment: props.environment,
      envParams: props.params,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
      contentsPath: path.join(__dirname, '../../../../../frontend/static-web/'), // Path to the local directory containing the static website content
      allowedIps: props.allowedIps,
      allowedIpv6s: props.allowedIpv6s,
    });
  }
}
