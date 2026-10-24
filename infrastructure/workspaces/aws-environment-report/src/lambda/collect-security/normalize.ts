import { Severity } from '../common/types';

/** One finding in the shape every security source is reduced to. */
export interface NormalizedFinding {
  readonly source: 'securityhub' | 'guardduty' | 'access-analyzer' | 'inspector';
  readonly region: string;
  readonly severity: Severity;
  readonly title: string;
  readonly type?: string;
  /** ARNs or resource IDs the finding names, used to place it on the diagram. */
  readonly resourceIds: string[];
  readonly resourceType?: string;
  readonly updatedAt?: string;
}

const LABELS = new Set<Severity>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL']);

/** Security Hub and Inspector already label severity; anything else (e.g. UNTRIAGED) is INFORMATIONAL. */
export function labelSeverity(label: string | undefined): Severity {
  return label && LABELS.has(label as Severity) ? (label as Severity) : 'INFORMATIONAL';
}

/** GuardDuty numeric severity, using GuardDuty's documented ranges. */
export function guardDutySeverity(score: number | undefined): Severity {
  const s = score ?? 0;
  if (s >= 9) return 'CRITICAL';
  if (s >= 7) return 'HIGH';
  if (s >= 4) return 'MEDIUM';
  if (s > 0) return 'LOW';
  return 'INFORMATIONAL';
}

/**
 * IAM Access Analyzer has no severity. This pipeline's own fixed rule:
 * public access is HIGH, other external access MEDIUM.
 */
export function accessAnalyzerSeverity(isPublic: boolean | undefined): Severity {
  return isPublic ? 'HIGH' : 'MEDIUM';
}

const ID_PATTERNS = [
  /^arn:aws[a-z-]*:/,
  /^i-[0-9a-f]{8,17}$/,
  /^vol-[0-9a-f]{8,17}$/,
  /^sg-[0-9a-f]{8,17}$/,
];

/**
 * Collects ARN- and ID-shaped strings from a nested resource description
 * (GuardDuty's Resource object differs per resource type, so walking it is
 * sturdier than listing every field).
 */
export function extractResourceIds(value: unknown, depth = 0, found = new Set<string>()): string[] {
  if (depth > 6 || value === null || value === undefined) {
    return [...found];
  }
  if (typeof value === 'string') {
    if (ID_PATTERNS.some((p) => p.test(value))) {
      found.add(value);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v) => extractResourceIds(v, depth + 1, found));
  } else if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((v) =>
      extractResourceIds(v, depth + 1, found)
    );
  }
  return [...found];
}

/**
 * Access Analyzer reports a global resource (an IAM role) once per region
 * with an analyzer. Keep one per resource + access shape.
 */
export function dedupeFindings(findings: NormalizedFinding[]): NormalizedFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    if (f.source !== 'access-analyzer') {
      return true;
    }
    const key = `${f.resourceIds.join(',')}|${f.title}|${f.severity}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
