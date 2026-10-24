import { ConfigurationRecorder, ConfigurationRecorderStatus } from '@aws-sdk/client-config-service';
import { SourceStatus } from '../common/types';

/**
 * Status of AWS Config in one region from its recorders:
 * - no recorder, or none recording           -> DISABLED
 * - a recording recorder that covers all types -> OK
 * - recording only a subset of resource types -> PARTIAL
 */
export function recorderStatus(
  recorders: ConfigurationRecorder[],
  statuses: ConfigurationRecorderStatus[]
): { status: SourceStatus; message?: string } {
  const recordingNames = new Set(statuses.filter((s) => s.recording).map((s) => s.name));
  const recording = recorders.filter((r) => recordingNames.has(r.name));
  if (recording.length === 0) {
    return { status: 'DISABLED', message: 'no configuration recorder is recording' };
  }
  const coversAll = recording.some((r) => {
    const group = r.recordingGroup;
    if (!group) {
      return false;
    }
    if (group.recordingStrategy?.useOnly) {
      return group.recordingStrategy.useOnly === 'ALL_SUPPORTED_RESOURCE_TYPES';
    }
    return group.allSupported === true;
  });
  return coversAll
    ? { status: 'OK' }
    : { status: 'PARTIAL', message: 'recorder records a subset of resource types only' };
}
