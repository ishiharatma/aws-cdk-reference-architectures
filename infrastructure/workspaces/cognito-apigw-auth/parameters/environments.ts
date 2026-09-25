import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /**
   * Enable the USER_PASSWORD_AUTH flow on the web client. It sends the password to Cognito directly
   * (no SRP), which is convenient for scripted verification but should be off in production.
   */
  readonly enablePasswordAuthFlow: boolean;
  /** OAuth callback URLs of the web client (authorization code + PKCE). */
  readonly callbackUrls: string[];
  /** OAuth sign-out URLs of the web client. */
  readonly logoutUrls: string[];
  /** API Gateway usage: steady-state requests per second. */
  readonly apiRateLimit: number;
  /** API Gateway usage: burst. */
  readonly apiBurstLimit: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
