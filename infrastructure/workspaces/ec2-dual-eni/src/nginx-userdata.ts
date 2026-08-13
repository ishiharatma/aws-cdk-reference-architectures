/**
 * Returns user data commands that install nginx and serve a demo page
 * showing instance metadata and both ENI IP addresses (eth0 / eth1).
 *
 * Fetches per-interface metadata via IMDSv2 to distinguish the internet-facing
 * ENI (eth0, with EIP) from the management ENI (eth1, SSH-only).
 *
 * Designed for Amazon Linux 2023.
 */
export function dualEniNginxUserData(): string[] {
  return [
    // Install nginx
    'dnf install -y nginx',

    // Get IMDSv2 token and basic instance metadata
    'TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
    'INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)',
    'AZ=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/availability-zone)',
    'HOSTNAME_VAL=$(hostname)',

    // Iterate over MAC addresses to identify eth0 and eth1 by device-number
    'ETH0_PRIVATE="N/A"',
    'ETH0_PUBLIC="N/A"',
    'ETH1_PRIVATE="N/A"',
    'MACS=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/network/interfaces/macs/)',
    'for MAC in $MACS; do',
    '  MAC_CLEAN=$(echo "$MAC" | tr -d "/")',
    '  DEVICE=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${MAC_CLEAN}/device-number")',
    '  if [ "$DEVICE" = "0" ]; then',
    '    ETH0_PRIVATE=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${MAC_CLEAN}/local-ipv4s")',
    '    ETH0_PUBLIC=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${MAC_CLEAN}/public-ipv4s" 2>/dev/null || echo "N/A")',
    '    [ -z "$ETH0_PUBLIC" ] && ETH0_PUBLIC="N/A"',
    '  elif [ "$DEVICE" = "1" ]; then',
    '    ETH1_PRIVATE=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${MAC_CLEAN}/local-ipv4s")',
    '  fi',
    'done',

    // Write the HTML page
    "cat > /usr/share/nginx/html/index.html << 'HTMLEOF'",
    '<!DOCTYPE html>',
    '<html lang="ja">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>EC2 Dual ENI Demo</title>',
    '  <style>',
    '    body { font-family: sans-serif; max-width: 680px; margin: 60px auto; padding: 0 24px; background: #f0f2f5; }',
    '    .card { background: #fff; border-radius: 10px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,.1); margin-bottom: 20px; }',
    '    h1 { color: #232f3e; margin-top: 0; font-size: 1.4em; }',
    '    h2 { color: #555; font-size: 1em; margin: 24px 0 12px; border-bottom: 1px solid #eee; padding-bottom: 6px; }',
    '    .row { margin-bottom: 14px; }',
    '    .label { color: #888; font-size: 0.75em; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 3px; }',
    '    .value { font-size: 1em; font-weight: 600; color: #111; word-break: break-all; }',
    '    .badge { display: inline-block; font-size: 0.7em; padding: 2px 8px; border-radius: 4px; margin-left: 8px; vertical-align: middle; font-weight: normal; }',
    '    .badge-internet { background: #d4edda; color: #155724; }',
    '    .badge-mgmt { background: #fff3cd; color: #856404; }',
    '    .note { font-size: 0.78em; color: #888; margin-top: 6px; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div class="card">',
    '    <h1>&#x1F5A7; EC2 Dual ENI Demo</h1>',
    '    <h2>Instance Info</h2>',
    '    <div class="row"><div class="label">Hostname</div><div class="value">HOSTNAME_PLACEHOLDER</div></div>',
    '    <div class="row"><div class="label">Instance ID</div><div class="value">INSTANCE_ID_PLACEHOLDER</div></div>',
    '    <div class="row"><div class="label">Availability Zone</div><div class="value">AZ_PLACEHOLDER</div></div>',
    '    <h2>Network Interfaces</h2>',
    '    <div class="row">',
    '      <div class="label">eth0 <span class="badge badge-internet">Internet-facing</span></div>',
    '      <div class="value">Public IP (EIP): ETH0_PUBLIC_PLACEHOLDER</div>',
    '      <div class="value" style="color:#555;font-size:.9em">Private IP: ETH0_PRIVATE_PLACEHOLDER</div>',
    '      <div class="note">&#x2705; HTTP/HTTPS open to 0.0.0.0/0</div>',
    '    </div>',
    '    <div class="row">',
    '      <div class="label">eth1 <span class="badge badge-mgmt">Management</span></div>',
    '      <div class="value">Private IP: ETH1_PRIVATE_PLACEHOLDER</div>',
    '      <div class="note">&#x1F512; SSH (port 22) restricted to specific CIDR only</div>',
    '    </div>',
    '  </div>',
    '</body>',
    '</html>',
    'HTMLEOF',

    // Replace placeholders with actual values
    'sed -i "s/HOSTNAME_PLACEHOLDER/${HOSTNAME_VAL}/g"        /usr/share/nginx/html/index.html',
    'sed -i "s/INSTANCE_ID_PLACEHOLDER/${INSTANCE_ID}/g"      /usr/share/nginx/html/index.html',
    'sed -i "s/AZ_PLACEHOLDER/${AZ}/g"                        /usr/share/nginx/html/index.html',
    'sed -i "s/ETH0_PUBLIC_PLACEHOLDER/${ETH0_PUBLIC}/g"      /usr/share/nginx/html/index.html',
    'sed -i "s/ETH0_PRIVATE_PLACEHOLDER/${ETH0_PRIVATE}/g"    /usr/share/nginx/html/index.html',
    'sed -i "s/ETH1_PRIVATE_PLACEHOLDER/${ETH1_PRIVATE}/g"    /usr/share/nginx/html/index.html',

    // Enable and start nginx
    'systemctl enable nginx',
    'systemctl start nginx',
  ];
}
