/**
 * Returns user data commands that install nginx and serve a sample page
 * showing the instance's hostname, instance ID, and Availability Zone.
 *
 * The page is rendered once at boot time using EC2 Instance Metadata (IMDSv2).
 * It is useful for demonstrating which instance is serving traffic behind an ALB.
 *
 * Designed for Amazon Linux 2023.
 */
export function nginxSamplePageUserData(): string[] {
  return [
    // Install nginx
    'dnf install -y nginx',

    // Fetch instance metadata via IMDSv2
    'TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
    'INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)',
    'AZ=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/availability-zone)',
    'HOSTNAME_VAL=$(hostname)',

    // Write the sample HTML page
    'cat > /usr/share/nginx/html/index.html << \'HTMLEOF\'',
    '<!DOCTYPE html>',
    '<html lang="ja">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>EC2 Sample Page</title>',
    '  <style>',
    '    body { font-family: sans-serif; max-width: 640px; margin: 60px auto; padding: 0 24px; background: #f0f2f5; }',
    '    .card { background: #fff; border-radius: 10px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,.1); }',
    '    h1 { color: #232f3e; margin-top: 0; }',
    '    .row { margin-bottom: 20px; }',
    '    .label { color: #888; font-size: 0.8em; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }',
    '    .value { font-size: 1.1em; font-weight: 600; color: #111; word-break: break-all; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div class="card">',
    '    <h1>&#x1F4BB; EC2 Instance Info</h1>',
    '    <div class="row"><div class="label">Hostname</div><div class="value">HOSTNAME_PLACEHOLDER</div></div>',
    '    <div class="row"><div class="label">Instance ID</div><div class="value">INSTANCE_ID_PLACEHOLDER</div></div>',
    '    <div class="row"><div class="label">Availability Zone</div><div class="value">AZ_PLACEHOLDER</div></div>',
    '  </div>',
    '</body>',
    '</html>',
    'HTMLEOF',

    // Replace placeholders with actual values
    'sed -i "s/HOSTNAME_PLACEHOLDER/${HOSTNAME_VAL}/g" /usr/share/nginx/html/index.html',
    'sed -i "s/INSTANCE_ID_PLACEHOLDER/${INSTANCE_ID}/g" /usr/share/nginx/html/index.html',
    'sed -i "s/AZ_PLACEHOLDER/${AZ}/g" /usr/share/nginx/html/index.html',

    // Enable and start nginx
    'systemctl enable nginx',
    'systemctl start nginx',
  ];
}
