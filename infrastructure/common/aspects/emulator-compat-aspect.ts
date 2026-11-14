import * as cdk from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

/**
 * Options for {@link EmulatorCompatAspect}.
 */
export interface EmulatorCompatAspectProps {
  /**
   * CloudFormation resource types to drop from the template.
   *
   * Defaults to {@link EmulatorCompatAspect.DEFAULT_REMOVED_TYPES}.
   */
  readonly removedResourceTypes?: string[];

  /**
   * Drop every custom resource (`Custom::*` and `AWS::CloudFormation::CustomResource`).
   *
   * The emulator's built-in Lambda runtimes have no `https` module, so the CDK provider
   * handlers cannot PUT their response to CloudFormation and the stack hangs, then rolls back.
   *
   * @default true
   */
  readonly removeCustomResources?: boolean;

  /**
   * Strip `Deny` statements conditioned on `aws:SecureTransport = false` from SQS, SNS and S3
   * resource policies (the statements `enforceSSL: true` adds).
   *
   * The emulator never puts `aws:SecureTransport` in the request context, so these statements
   * deny requests AWS allows — for example the Lambda poller of an SQS event source mapping.
   *
   * @default true
   */
  readonly stripSecureTransportDeny?: boolean;
}

/**
 * Rewrites a synthesized app so that it can be deployed to AWS Emulator
 * (https://docs.aws.amazon.com/emulator/).
 *
 * This aspect is for local testing ONLY. It removes security controls (TLS-only resource
 * policies) and operational helpers (custom resources, vended log deliveries) that the
 * emulator cannot run. Never apply it to a stack deployed to a real AWS account.
 *
 * Every change is reported as a synth-time warning so the gap stays visible.
 *
 * Add it to the Stage (or Stack) that holds the stacks: aspects added to the App do not
 * cross Stage boundaries.
 *
 * Deploying with cdkd (`cdkd deploy --aws-emulator`) instead of the CDK CLI runs custom
 * resource handlers locally in the official Lambda runtime image, so pass
 * `removeCustomResources: false` there.
 *
 * @example
 * if (app.node.tryGetContext('emulator') === 'true') {
 *   cdk.Aspects.of(stage).add(new EmulatorCompatAspect());
 * }
 */
export class EmulatorCompatAspect implements cdk.IAspect {
  /** Resource types AWS Emulator 1.0.343 / 1.0.348 rejects with "Unrecognized resource types". */
  public static readonly DEFAULT_REMOVED_TYPES = [
    'AWS::Logs::DeliverySource',
    'AWS::Logs::DeliveryDestination',
    'AWS::Logs::Delivery',
  ];

  private static readonly POLICY_TYPES = new Set([
    'AWS::SQS::QueuePolicy',
    'AWS::SNS::TopicPolicy',
    'AWS::S3::BucketPolicy',
  ]);

  private readonly removedTypes: Set<string>;
  private readonly removeCustomResources: boolean;
  private readonly stripSecureTransportDeny: boolean;

  /**
   * Creates the aspect.
   * @param props - which rewrites to apply; all are enabled by default
   */
  constructor(props: EmulatorCompatAspectProps = {}) {
    this.removedTypes = new Set(props.removedResourceTypes ?? EmulatorCompatAspect.DEFAULT_REMOVED_TYPES);
    this.removeCustomResources = props.removeCustomResources ?? true;
    this.stripSecureTransportDeny = props.stripSecureTransportDeny ?? true;
  }

  /**
   * Removes or rewrites a single CloudFormation resource.
   * @param node - the construct being visited
   */
  public visit(node: IConstruct): void {
    if (!cdk.CfnResource.isCfnResource(node)) {
      return;
    }
    const type = node.cfnResourceType;

    if (this.removedTypes.has(type) || (this.removeCustomResources && EmulatorCompatAspect.isCustomResource(type))) {
      this.remove(node, `${type} is not supported by AWS Emulator`);
      return;
    }

    if (this.stripSecureTransportDeny && EmulatorCompatAspect.POLICY_TYPES.has(type)) {
      this.stripTlsDeny(node);
    }
  }

  /**
   * Whether the type is a CloudFormation custom resource.
   * @param type - CloudFormation resource type
   * @returns true for `Custom::*` and `AWS::CloudFormation::CustomResource`
   */
  private static isCustomResource(type: string): boolean {
    return type.startsWith('Custom::') || type === 'AWS::CloudFormation::CustomResource';
  }

  /**
   * Detaches the resource from the tree and records a synth-time warning.
   * @param resource - the resource to remove
   * @param reason - why it is removed
   */
  private remove(resource: cdk.CfnResource, reason: string): void {
    const scope = resource.node.scope;
    if (!scope || !scope.node.tryRemoveChild(resource.node.id)) {
      cdk.Annotations.of(resource).addWarningV2('emulator-compat:remove-failed', `Could not remove (${reason})`);
      return;
    }
    cdk.Annotations.of(scope).addWarningV2(
      `emulator-compat:removed:${resource.node.id}`,
      `[EmulatorCompat] removed ${resource.node.path}: ${reason}`,
    );
  }

  /**
   * Drops the `aws:SecureTransport = false` deny statements from a resource policy.
   * @param policy - an SQS, SNS or S3 resource policy
   */
  private stripTlsDeny(policy: cdk.CfnResource): void {
    const stack = cdk.Stack.of(policy);
    // CfnQueuePolicy, CfnTopicPolicy and CfnBucketPolicy all expose `policyDocument`.
    const document = stack.resolve((policy as unknown as { policyDocument?: unknown }).policyDocument) as
      | { Statement?: Record<string, unknown>[] }
      | undefined;
    const statements = document?.Statement ?? [];
    const kept = statements.filter((s) => !EmulatorCompatAspect.isTlsDeny(s));
    if (kept.length === statements.length) {
      return;
    }
    if (kept.length === 0) {
      this.remove(policy, 'only contained an aws:SecureTransport deny that AWS Emulator cannot evaluate');
      return;
    }
    policy.addPropertyOverride('PolicyDocument.Statement', kept);
    cdk.Annotations.of(policy).addWarningV2(
      'emulator-compat:tls-deny',
      `[EmulatorCompat] stripped ${statements.length - kept.length} aws:SecureTransport deny statement(s)`,
    );
  }

  /**
   * Whether the statement is the deny `enforceSSL` adds.
   * @param statement - a resolved policy statement
   * @returns true for `Deny` conditioned on `aws:SecureTransport = false`
   */
  private static isTlsDeny(statement: Record<string, unknown>): boolean {
    if (statement.Effect !== 'Deny') {
      return false;
    }
    const bool = (statement.Condition as Record<string, Record<string, unknown>> | undefined)?.Bool;
    const value = bool?.['aws:SecureTransport'];
    return value === 'false' || value === false;
  }
}
