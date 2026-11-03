import * as fs from 'fs';
import * as path from 'path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Ubuntu 24.04 LTS (arm64) published by Canonical through SSM public parameters.
 *
 * Ubuntu is used for every instance because both `openvpn` and `wireguard-tools` are in its main
 * archive (Amazon Linux 2023 ships neither), so all three VPN servers and the client simulator use
 * the same OS and the comparison is not skewed by distribution differences.
 */
export const UBUNTU_2404_ARM64_PARAM =
  '/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id';

/** AMI of the latest Ubuntu 24.04 arm64 release, resolved at deploy time. */
export function ubuntuImage(): ec2.IMachineImage {
  return ec2.MachineImage.fromSsmParameter(UBUNTU_2404_ARM64_PARAM, { os: ec2.OperatingSystemType.LINUX });
}

/** Encrypted gp3 root volume shared by all instances. */
export function encryptedRootVolume(sizeGiB = 8): ec2.BlockDevice {
  return {
    deviceName: '/dev/sda1',
    volume: ec2.BlockDeviceVolume.ebs(sizeGiB, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3 }),
  };
}

/** Reads a file under `src/` so it can be embedded into user data. */
export function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', relativePath), 'utf8');
}

/**
 * Replaces `@@NAME@@` placeholders in a script with values (tokens allowed).
 * Throws when a placeholder is left unresolved so a typo fails at synth time, not at boot.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.split(`@@${key}@@`).join(value);
  }
  const leftover = rendered.match(/@@[A-Z0-9_]+@@/);
  if (leftover) {
    throw new Error(`Unresolved placeholder ${leftover[0]} in user data template`);
  }
  return rendered;
}
