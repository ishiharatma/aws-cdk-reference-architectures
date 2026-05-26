/**
 * S3 lifecycle transition parameters for tiered archiving (Stack 2)
 */
export interface LifecycleArchiveParams {
    /**
     * Days after which current objects transition to Standard-IA
     * @default 30
     */
    readonly moveToIaAfterDays?: number;
    /**
     * Days after which current objects transition to Glacier Instant Retrieval
     * @default 90
     */
    readonly moveToGlacierAfterDays?: number;
    /**
     * Days after which current objects transition to Glacier Deep Archive
     * @default 365
     */
    readonly moveToDeepArchiveAfterDays?: number;
    /**
     * Days after which current objects expire (delete)
     * Set to 0 to disable expiration
     * @default 2555 (7 years)
     */
    readonly expireAfterDays?: number;
    /**
     * Days after which non-current versions expire
     * @default 90
     */
    readonly noncurrentVersionExpirationDays?: number;
    /**
     * Number of non-current versions to retain before expiring older ones
     * @default 3
     */
    readonly noncurrentVersionsToRetain?: number;
}

export const defaultLifecycleConfig: Required<LifecycleArchiveParams> = {
    moveToIaAfterDays: 30,
    moveToGlacierAfterDays: 90,
    moveToDeepArchiveAfterDays: 365,
    expireAfterDays: 2555,
    noncurrentVersionExpirationDays: 90,
    noncurrentVersionsToRetain: 3,
};
