#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { getMyGlobalIp, getMyGlobalIpv6 } from '@common/helpers/get-my-ip';
import { validateDeployment } from '@common/helpers/validate-deployment';
import { params } from 'parameters/environments';
import 'parameters'; // registers dev-params into `params` as a side effect
import { TransitGatewayStage } from 'lib/stages/transit-gateway-stage';

const app = new cdk.App();

// Get environment (specified in cdk.json context or at runtime with --context)
const pjName: string = process.env.PROJECT || app.node.tryGetContext('project');
const envName: Environment =
    (process.env.ENV as Environment) ||
    app.node.tryGetContext('env') ||
    Environment.DEVELOPMENT;

const envParams = params[envName];
if (!envParams) {
    throw new Error(`No parameters found for environment: ${envName}`);
}

validateDeployment(pjName, envName, envParams.accountId);

const defaultEnv = {
    account: process.env.CDK_DEFAULT_ACCOUNT || envParams.accountId,
    region: process.env.CDK_DEFAULT_REGION || envParams.region,
};

// Since this is a demonstration workspace, resources can always be deleted.
const isAutoDeleteObject = true;
const isTerminationProtection = envName === Environment.PRODUCTION;

// SSH allowlist for the test instances. Prefer an explicit `ALLOWED_IPS` env var
// (comma-separated, e.g. `ALLOWED_IPS=1.2.3.4,5.6.7.8`) — useful when the machine
// running `cdk deploy` is not the one you SSH from (e.g. deploying from a devcontainer
// but connecting from your laptop). Falls back to auto-detecting this machine's own
// global IP. IPv6 is best-effort: many deploy environments have no IPv6 egress, in
// which case only the IPv4 allowlist is applied.
const parseIpListEnv = (value: string | undefined): string[] | undefined => {
    const ips = value?.split(',').map((ip) => ip.trim()).filter(Boolean);
    return ips && ips.length > 0 ? ips : undefined;
};

const allowedIps = parseIpListEnv(process.env.ALLOWED_IPS) ?? [getMyGlobalIp()];
console.log(`SSH allowlist IPv4: ${allowedIps.join(', ')}`);
const allowedIpv6s = parseIpListEnv(process.env.ALLOWED_IPV6S) ?? (() => {
    const myIpv6 = getMyGlobalIpv6();
    return myIpv6 ? [myIpv6] : undefined;
})();
console.log(`SSH allowlist IPv6: ${allowedIpv6s?.join(', ') ?? 'none'}`);

const stage = new TransitGatewayStage(app, `TransitGateway${pascalCase(envName)}`, {
    project: pjName,
    environment: envName,
    env: defaultEnv,
    terminationProtection: isTerminationProtection,
    isAutoDeleteObject: isAutoDeleteObject,
    params: envParams,
    allowedIps,
    allowedIpv6s,
});

// --------------------------------- Tagging  -------------------------------------
cdk.Tags.of(stage).add('Project', pjName);
cdk.Tags.of(stage).add('Environment', envName);
cdk.Tags.of(stage).add('ManagedBy', 'CDK');
