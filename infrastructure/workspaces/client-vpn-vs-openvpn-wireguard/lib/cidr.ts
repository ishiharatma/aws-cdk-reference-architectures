/** Splits `10.0.0.0/16` into network address and dotted netmask (`255.255.0.0`) for OpenVPN. */
export function cidrToNetmask(cidr: string): { network: string; netmask: string; prefix: number } {
  const [network, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!network || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid IPv4 CIDR: ${cidr}`);
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const netmask = [24, 16, 8, 0].map((shift) => (mask >>> shift) & 0xff).join('.');
  return { network, netmask, prefix };
}

/** Returns the n-th host address of a CIDR (`10.0.0.0/24`, 1 -> `10.0.0.1`). */
export function hostAddress(cidr: string, n: number): string {
  const { network } = cidrToNetmask(cidr);
  const value = network.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0) + n;
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}
