import { execSync } from 'child_process';

export function getMyGlobalIp(): string {
  try {
    const ip = execSync('curl -s http://checkip.amazonaws.com', {
      encoding: 'utf-8',
      timeout: 5000, // Timeout after 5 seconds
    }).trim();

    // Validate IP address format
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(ip)) {
      throw new Error(`Invalid IP address format: ${ip}`);
    }

    return ip;
  } catch (error) {
    console.error('Failed to fetch IP address:', error);
    throw new Error('Could not retrieve global IP address');
  }
}

export function getMyGlobalIpCidr(cidrMask = 32): string {
  const ip = getMyGlobalIp();
  return `${ip}/${cidrMask}`;
}

/**
 * Fetches this machine's global IPv6 address by forcing an IPv6-only connection
 * (`curl -6` against an IPv6-only endpoint). Unlike {@link getMyGlobalIp}, this returns
 * `undefined` instead of throwing when unavailable, since many deploy environments
 * (CI runners, some devcontainers) have no IPv6 egress at all — that's an expected
 * condition here, not an error.
 */
export function getMyGlobalIpv6(): string | undefined {
  try {
    const ip = execSync('curl -s -6 https://api6.ipify.org', {
      encoding: 'utf-8',
      timeout: 5000, // Timeout after 5 seconds
    }).trim();

    // Validate IPv6 address format (loose check: hex groups and colons only, at least one "::" or multiple colons)
    const ipv6Regex = /^[0-9a-fA-F:]+$/;
    if (!ip || !ip.includes(':') || !ipv6Regex.test(ip)) {
      throw new Error(`Invalid IPv6 address format: ${ip}`);
    }

    return ip;
  } catch (error) {
    console.warn('Could not retrieve global IPv6 address (this machine may have no IPv6 connectivity):', error);
    return undefined;
  }
}

export function getMyGlobalIpv6Cidr(cidrMask = 128): string | undefined {
  const ip = getMyGlobalIpv6();
  return ip ? `${ip}/${cidrMask}` : undefined;
}