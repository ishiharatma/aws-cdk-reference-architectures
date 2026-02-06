
export interface AthenaConfig {
    readonly createConfig?: AthenaCreateConfig;
}


export interface AthenaCreateConfig {
  readonly enabledQueryLogging: boolean;
}