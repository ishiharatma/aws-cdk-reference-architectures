import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from "parameters/environments";
import * as path from 'path';
import { CloudfrontS3StaticWebsiteStack } from 'lib/stacks/cloudfront-s3-static-website-stack';
import { CloudfrontWafStack } from 'lib/stacks/cloudfront-waf-stack';

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
    readonly allowedIps: string[];
    /** IPv6 counterpart to `allowedIps`. Omit or pass an empty array if unavailable. */
    readonly allowedIpv6s?: string[];
}

export class CloudfrontS3StaticWebsiteStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    // WAFv2 Web ACLs scoped to CLOUDFRONT can only be created in us-east-1, regardless of the
    // distribution's own region, so this is a separate stack forced into us-east-1. Its Web ACL
    // ARN is then handed to the main stack to associate with the distribution.
    const wafStack = new CloudfrontWafStack(this, pascalCase(`${props.project}Waf`), {
      project: props.project,
      description: `${pascalCase(props.project)} CloudFront WAF Stack for ${props.environment}`,
      environment: props.environment,
      allowedIpsAfterRules: props.allowedIps,
      allowedIpv6sAfterRules: props.allowedIpv6s,
      //allowedIpsBeforeRules: props.allowedIps,
      env: { account: props.params.accountId, region: 'us-east-1' },
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      crossRegionReferences: true,
      enableWaf: props.params.enableWaf, // Pass the enableWaf parameter to the WAF stack
    });

    const mainStack = new CloudfrontS3StaticWebsiteStack(this, pascalCase(`${props.project}Main`), {
      project: props.project,
      description: `${pascalCase(props.project)} Cloudfront S3 Static Website Stack for ${props.environment}`,
      environment: props.environment,
      envParams: props.params,
      webAclArn: wafStack.webAclArn,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
      crossRegionReferences: true,
      contentsPath: path.join(__dirname, '../../../../../frontend/static-web/'), // Path to the local directory containing the static website content
      geoRestrictionCountries: props.params.geoRestrictionCountries, // Pass the geoRestrictionCountries parameter to the main stack
    });
    mainStack.addStackDependency(wafStack);

  }
}
