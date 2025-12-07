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