/**
 * Configuration for the session control-plane (API Gateway HTTP API + the
 * Lambda functions that call the Lambda MicroVMs data-plane API on the
 * caller's behalf).
 */
export interface ControlPlaneParams {
  /**
   * Maximum minutes a single Codex session's MicroVM may run before the
   * platform force-terminates it (`RunMicrovmRequest.maximumDurationInSeconds`).
   * @default 60
   */
  readonly maxSessionDurationInMinutes?: number;

  /**
   * Minutes of inactivity before a session's MicroVM auto-suspends
   * (`RunMicrovmRequest.idlePolicy`), pausing Firecracker memory/disk state
   * and billing only for snapshot storage.
   * @default 5
   */
  readonly idleTimeoutInMinutes?: number;

  /**
   * Whether an inbound request to a SUSPENDED MicroVM should transparently
   * resume it, versus requiring an explicit `resume-microvm` call.
   * @default true
   */
  readonly autoResumeEnabled?: boolean;

  /**
   * Minutes a MicroVM may remain SUSPENDED (billed only for snapshot
   * storage) before the platform automatically terminates it
   * (`IdlePolicy.suspendedDurationSeconds`).
   * @default 480
   */
  readonly suspendedDurationInMinutes?: number;

  /**
   * Minutes a `CreateMicrovmAuthToken` token stays valid before the client
   * must ask the control plane for a new one. The API enforces a hard
   * maximum of 60 minutes.
   * @default 15
   */
  readonly authTokenExpirationInMinutes?: number;

  /**
   * Days after which an expired session's DynamoDB record is purged via TTL.
   * @default 1
   */
  readonly sessionRecordTtlInDays?: number;
}

export const defaultControlPlaneConfig: Required<ControlPlaneParams> = {
  maxSessionDurationInMinutes: 60,
  idleTimeoutInMinutes: 5,
  autoResumeEnabled: true,
  suspendedDurationInMinutes: 480,
  authTokenExpirationInMinutes: 15,
  sessionRecordTtlInDays: 1,
};
