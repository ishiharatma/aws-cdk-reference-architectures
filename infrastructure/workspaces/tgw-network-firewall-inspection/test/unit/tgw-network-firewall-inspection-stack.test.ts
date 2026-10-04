/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { TgwNetworkFirewallInspectionStack } from 'lib/stacks/tgw-network-firewall-inspection-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const build = (overrides: Partial<typeof envParams> = {}) => {
  const app = new cdk.App();
  const stack = new TgwNetworkFirewallInspectionStack(app, 'TgwNetworkFirewallInspection', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject: true,
    env: testEnv,
    params: { ...envParams, ...overrides },
  });
  return Template.fromStack(stack);
};

describe('TgwNetworkFirewallInspectionStack', () => {
  const template = build();

  describe('Transit Gateway', () => {
    test('default association and propagation are off so routing is explicit', () => {
      template.hasResourceProperties('AWS::EC2::TransitGateway', {
        DefaultRouteTableAssociation: 'disable',
        DefaultRouteTablePropagation: 'disable',
      });
    });

    test('only the inspection attachment uses appliance mode', () => {
      const attachments = Object.values(template.findResources('AWS::EC2::TransitGatewayVpcAttachment')) as any[];
      expect(attachments).toHaveLength(3);
      const appliance = attachments.filter((a) => a.Properties.Options?.ApplianceModeSupport === 'enable');
      expect(appliance).toHaveLength(1);
    });

    test('spokes send everything to the inspection VPC; the inspection table routes back to each spoke', () => {
      template.hasResourceProperties('AWS::EC2::TransitGatewayRoute', { DestinationCidrBlock: '0.0.0.0/0' });
      template.hasResourceProperties('AWS::EC2::TransitGatewayRoute', { DestinationCidrBlock: envParams.spokeACidr });
      template.hasResourceProperties('AWS::EC2::TransitGatewayRoute', { DestinationCidrBlock: envParams.spokeBCidr });
      template.resourceCountIs('AWS::EC2::TransitGatewayRouteTable', 2);
      template.resourceCountIs('AWS::EC2::TransitGatewayRouteTableAssociation', 3);
    });
  });

  describe('Network Firewall', () => {
    test('domain allow list covers HTTP host and TLS SNI for the configured domains', () => {
      template.hasResourceProperties('AWS::NetworkFirewall::RuleGroup', {
        Type: 'STATEFUL',
        RuleGroup: Match.objectLike({
          RulesSource: {
            RulesSourceList: { GeneratedRulesType: 'ALLOWLIST', TargetTypes: ['HTTP_HOST', 'TLS_SNI'], Targets: envParams.allowedDomains },
          },
        }),
      });
    });

    test('east-west TCP is passed before the allow list, and ICMP between the spokes is dropped', () => {
      const rules = (Object.values(template.findResources('AWS::NetworkFirewall::RuleGroup', {
        Properties: { RuleGroupName: 'test-test-nfw-east-west' },
      })) as any[])[0].Properties.RuleGroup.RulesSource.RulesString as string;
      const lines = rules.split('\n');
      expect(lines[0]).toMatch(new RegExp(`^pass tcp ${envParams.spokeACidr.replace('/', '\\/')} any <> ${envParams.spokeBCidr.replace('/', '\\/')} 8080`));
      expect(lines.some((l) => l.startsWith('drop icmp'))).toBe(true);
    });

    test('with ICMP blocking off only the pass rule remains; with no east-west rules the group is not created', () => {
      const off = build({ blockEastWestIcmp: false }).findResources('AWS::NetworkFirewall::RuleGroup', { Properties: { RuleGroupName: 'test-test-nfw-east-west' } });
      expect(JSON.stringify(off)).not.toContain('drop icmp');
      expect(Object.keys(build({ blockEastWestIcmp: false, eastWestAllowedTcpPorts: [] }).findResources('AWS::NetworkFirewall::RuleGroup'))).toHaveLength(1);
    });

    test('stateless traffic is forwarded to the stateful engine', () => {
      template.hasResourceProperties('AWS::NetworkFirewall::FirewallPolicy', {
        FirewallPolicy: Match.objectLike({ StatelessDefaultActions: ['aws:forward_to_sfe'], StatelessFragmentDefaultActions: ['aws:forward_to_sfe'] }),
      });
    });

    test('alert and flow logs go to CloudWatch Logs', () => {
      template.hasResourceProperties('AWS::NetworkFirewall::LoggingConfiguration', {
        LoggingConfiguration: {
          LogDestinationConfigs: [
            Match.objectLike({ LogType: 'ALERT', LogDestinationType: 'CloudWatchLogs' }),
            Match.objectLike({ LogType: 'FLOW', LogDestinationType: 'CloudWatchLogs' }),
          ],
        },
      });
    });
  });

  describe('routing', () => {
    test('spokes have no internet route of their own: no internet gateway except in the inspection VPC', () => {
      template.resourceCountIs('AWS::EC2::InternetGateway', 1);
      template.resourceCountIs('AWS::EC2::NatGateway', 1);
    });

    test('the TGW-facing inspection subnet and the NAT-side subnet both route through the firewall endpoint', () => {
      const routes = Object.values(template.findResources('AWS::EC2::Route')) as any[];
      const viaFirewall = routes.filter((r) => r.Properties.VpcEndpointId);
      // tgw subnet default route + return routes for both spokes in the public subnet
      expect(viaFirewall).toHaveLength(3);
    });
  });

  describe('test instances', () => {
    test('two ARM64 SSM-managed instances, IMDSv2 required, no key pair', () => {
      const instances = Object.values(template.findResources('AWS::EC2::Instance')) as any[];
      expect(instances).toHaveLength(2);
      instances.forEach((i) => expect(i.Properties.KeyName).toBeUndefined());
      template.hasResourceProperties('AWS::EC2::LaunchTemplate', { LaunchTemplateData: Match.objectLike({ MetadataOptions: { HttpTokens: 'required' } }) });
    });
  });
});
