import { VpcConfig } from '@common/types';
import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/** Keycloak ECS Fargate configuration */
export interface KeycloakEcsConfig {
  /** Keycloak container image version (e.g. '26.1') */
  readonly keycloakVersion: string;
  /** Keycloak realm name to create on first setup */
  readonly realmName: string;
  /** ECS task CPU units */
  readonly cpu: number;
  /** ECS task memory in MiB */
  readonly memoryLimitMiB: number;
  /** Desired number of Keycloak tasks */
  readonly desiredCount: number;
}

/** Aurora Serverless V2 configuration for Keycloak */
export interface AuroraKeycloakConfig {
  /** Database name for Keycloak */
  readonly databaseName: string;
  /** Master username */
  readonly masterUsername: string;
  /** Serverless V2 min ACU (0.5 minimum) */
  readonly serverlessV2MinCapacity: number;
  /** Serverless V2 max ACU */
  readonly serverlessV2MaxCapacity: number;
}

/** ALB OIDC authentication configuration */
export interface OidcAlbConfig {
  /**
   * Whether to enable OIDC authentication on the App ALB.
   * Requires appDomainName and appHostedZoneId to be set.
   */
  readonly enabled: boolean;
  /** OIDC client ID registered in Keycloak */
  readonly clientId: string;
}

/**
 * Optional SAML IdP configuration for Keycloak identity brokering.
 * When enabled, Keycloak acts as a SAML Service Provider to an external IdP
 * while still exposing OIDC endpoints to the ALB.
 */
export interface SamlIdpConfig {
  /** Whether SAML federation is enabled */
  readonly enabled: boolean;
  /** Short alias used internally in Keycloak */
  readonly idpAlias: string;
  /** Display name shown to users in the Keycloak login UI */
  readonly idpDisplayName: string;
  /** URL to the SAML IdP metadata XML */
  readonly idpMetadataUrl: string;
}

/** Per-environment parameters */
export interface EnvParams extends EnvironmentConfig {
  readonly vpcConfig: VpcConfig;
  readonly auroraConfig: AuroraKeycloakConfig;
  readonly keycloakConfig: KeycloakEcsConfig;
  readonly oidcConfig: OidcAlbConfig;
  /** Optional SAML IdP federation. Configure via scripts/saml-setup.sh after deploy. */
  readonly samlConfig?: SamlIdpConfig;
  /** Custom domain for the Keycloak ALB (requires Route53 Hosted Zone) */
  readonly keycloakDomainName?: string;
  readonly keycloakHostedZoneId?: string;
  /** Custom domain for the App ALB (required when oidcConfig.enabled=true) */
  readonly appDomainName?: string;
  readonly appHostedZoneId?: string;
}

export const params: Partial<Record<Environment, EnvParams>> = {};
