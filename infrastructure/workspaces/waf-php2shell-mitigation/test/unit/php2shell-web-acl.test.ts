/* eslint-disable @typescript-eslint/no-explicit-any */
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildWafStack, testParams } from '../helpers/stack';

/** Rule as rendered in the CloudFormation template. */
interface Rule {
  Name: string;
  Priority: number;
  Action?: Record<string, unknown>;
  Statement: Record<string, any>;
}

const rulesOf = (template: Template): Rule[] => {
  const acls = template.findResources('AWS::WAFv2::WebACL');
  return (Object.values(acls)[0] as any).Properties.Rules as Rule[];
};
const ruleNamed = (template: Template, name: string): Rule => {
  const rule = rulesOf(template).find((r) => r.Name === name);
  if (!rule) throw new Error(`rule ${name} not found`);
  return rule;
};

describe('Php2ShellWebAcl (CloudFront scope)', () => {
  const template = Template.fromStack(buildWafStack());

  test('creates a CLOUDFRONT Web ACL with the 64 KB body inspection limit', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      AssociationConfig: { RequestBody: { CLOUDFRONT: { DefaultSizeInspectionLimit: 'KB_64' } } },
    });
  });

  test('defaults to BLOCK and allows only the allow-listed client IP', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', { DefaultAction: { Block: {} } });
    template.hasResourceProperties('AWS::WAFv2::IPSet', {
      Scope: 'CLOUDFRONT',
      Addresses: ['203.0.113.10/32'],
    });
    expect(ruleNamed(template, 'AllowListedIps').Action).toEqual({ Allow: {} });
  });

  test('evaluates the rules in the blog order', () => {
    expect(rulesOf(template).map((r) => [r.Name, r.Priority])).toEqual([
      ['PHP2Shell', 0],
      ['Block-Multipart-FormData', 1],
      ['Block-Oversize-Body', 3],
      ['RateLimit-Posts', 4],
      ['AllowListedIps', 100],
    ]);
  });

  test('PHP2Shell rule requires POST, PHPSESSID (cookie key or body) and the upload progress field', () => {
    const statements = ruleNamed(template, 'PHP2Shell').Statement.AndStatement.Statements;
    expect(statements[0].ByteMatchStatement).toMatchObject({
      FieldToMatch: { Method: {} },
      PositionalConstraint: 'EXACTLY',
      SearchString: 'POST',
    });
    const [cookie, bodySessId] = statements[1].OrStatement.Statements;
    expect(cookie.ByteMatchStatement).toMatchObject({
      FieldToMatch: { Cookies: { MatchPattern: { All: {} }, MatchScope: 'KEY' } },
      PositionalConstraint: 'EXACTLY',
      SearchString: 'PHPSESSID',
    });
    expect(bodySessId.ByteMatchStatement).toMatchObject({
      FieldToMatch: { Body: { OversizeHandling: 'CONTINUE' } },
      PositionalConstraint: 'CONTAINS',
      SearchString: 'PHPSESSID',
    });
    expect(statements[2].ByteMatchStatement).toMatchObject({
      FieldToMatch: { Body: { OversizeHandling: 'CONTINUE' } },
      SearchString: 'PHP_SESSION_UPLOAD_PROGRESS',
    });
  });

  test('BLOCK answers 403 naming the layer and rule', () => {
    expect(ruleNamed(template, 'PHP2Shell').Action).toEqual({
      Block: {
        CustomResponse: {
          ResponseCode: 403,
          ResponseHeaders: [{ Name: 'x-php2shell-blocked-by', Value: 'cloudfront:PHP2Shell' }],
        },
      },
    });
  });

  test('COUNT inserts a request header the origin can echo back', () => {
    expect(ruleNamed(template, 'Block-Multipart-FormData').Action).toEqual({
      Count: { CustomRequestHandling: { InsertHeaders: [{ Name: 'php2shell-cloudfront-multipart', Value: 'counted' }] } },
    });
  });

  test('multipart rule matches the content-type header case-insensitively', () => {
    expect(ruleNamed(template, 'Block-Multipart-FormData').Statement.ByteMatchStatement).toMatchObject({
      FieldToMatch: { SingleHeader: { Name: 'content-type' } },
      SearchString: 'multipart/form-data',
      TextTransformations: [{ Priority: 0, Type: 'LOWERCASE' }],
    });
  });

  test('oversize rule treats bodies beyond the inspection limit as a match', () => {
    expect(ruleNamed(template, 'Block-Oversize-Body').Statement.SizeConstraintStatement).toMatchObject({
      FieldToMatch: { Body: { OversizeHandling: 'MATCH' } },
      ComparisonOperator: 'GT',
      Size: testParams().waf.cloudFront.oversizeBodyBytes,
    });
  });

  test('rate rule counts POSTs per client IP over 60 seconds', () => {
    expect(ruleNamed(template, 'RateLimit-Posts').Statement.RateBasedStatement).toMatchObject({
      Limit: 100,
      EvaluationWindowSec: 60,
      AggregateKeyType: 'IP',
      ScopeDownStatement: { ByteMatchStatement: { SearchString: 'POST' } },
    });
  });

  test('sends WAF logs to an aws-waf-logs- log group', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: 'aws-waf-logs-test-test-php2shell-cloudfront',
      RetentionInDays: 7,
    });
    template.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
      LogDestinationConfigs: [Match.objectLike({ 'Fn::Join': Match.anyValue() })],
    });
  });
});

describe('Php2ShellWebAcl rule actions follow the parameters', () => {
  test('oversize rule becomes BLOCK with its own threshold', () => {
    const base = testParams();
    const template = Template.fromStack(
      buildWafStack(undefined, {
        waf: {
          ...base.waf,
          cloudFront: {
            ...base.waf.cloudFront,
            oversizeBodyBytes: 65536,
            ruleActions: { ...base.waf.cloudFront.ruleActions, blockOversizeBody: 'BLOCK' },
          },
        },
      }),
    );
    const rule = ruleNamed(template, 'Block-Oversize-Body');
    expect(rule.Statement.SizeConstraintStatement.Size).toBe(65536);
    expect(rule.Action).toMatchObject({ Block: { CustomResponse: { ResponseCode: 403 } } });
  });
});
