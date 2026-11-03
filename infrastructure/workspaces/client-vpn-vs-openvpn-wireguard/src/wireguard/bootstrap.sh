#!/bin/bash
# WireGuard server bootstrap (Ubuntu 24.04, in-kernel WireGuard). Placeholders @@...@@ are filled by CDK.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# The Elastic IP replaces the launch-time public IP a few seconds after boot, which drops any
# connection in flight; retry every network step instead of failing the whole bootstrap.
retry() { for i in $(seq 1 10); do "$@" && return 0; sleep 15; done; return 1; }

REGION='@@REGION@@'
SECRET_ID='@@SECRET_ID@@'
PEERS_PARAM='@@PEERS_PARAM@@'
PORT='@@PORT@@'
SERVER_ADDRESS='@@SERVER_ADDRESS@@'
TUNNEL_CIDR='@@TUNNEL_CIDR@@'
LOG_GROUP='@@LOG_GROUP@@'

retry apt-get -o DPkg::Lock::Timeout=600 update
retry apt-get -o DPkg::Lock::Timeout=600 install -y wireguard-tools jq
retry snap install aws-cli --classic

cat > /etc/sysctl.d/90-vpn-forward.conf <<'EOF'
net.ipv4.ip_forward = 1
EOF
sysctl --system

# ---- render /etc/wireguard/wg0.conf from Secrets Manager (server key) and SSM (peer list) ----
cat > /usr/local/sbin/wg-render.sh <<EOF
#!/bin/bash
# Re-run to apply peer additions / removals: wg-render.sh && wg syncconf wg0 <(wg-quick strip wg0)
set -euo pipefail
umask 077
IFACE=\$(ip route show default | awk '{print \$5; exit}')
PRIVATE_KEY=\$(/snap/bin/aws secretsmanager get-secret-value --region $REGION --secret-id $SECRET_ID --query SecretString --output text | jq -r .privateKey)
PEERS=\$(/snap/bin/aws ssm get-parameter --region $REGION --name $PEERS_PARAM --query Parameter.Value --output text)
{
  echo "[Interface]"
  echo "Address = $SERVER_ADDRESS"
  echo "ListenPort = $PORT"
  echo "PrivateKey = \$PRIVATE_KEY"
  # wg-quick would derive 8921 from the 9001-byte jumbo MTU of the ENI, but the internet path is
  # 1500 bytes: tunnel packets then get fragmented and throughput drops ~30x. 1420 = 1500 - 80.
  echo "MTU = @@MTU@@"
  # Source NAT so VPC resources see the server's private IP; no route table changes needed.
  echo "PostUp = iptables -t nat -A POSTROUTING -s $TUNNEL_CIDR -o \$IFACE -j MASQUERADE"
  echo "PostDown = iptables -t nat -D POSTROUTING -s $TUNNEL_CIDR -o \$IFACE -j MASQUERADE"
  echo "\$PEERS" | jq -r '.[] | "\n# \(.name)\n[Peer]\nPublicKey = \(.publicKey)\nAllowedIPs = \(.address)"'
} > /etc/wireguard/wg0.conf
echo "\$PEERS" | jq -r '.[] | "\(.publicKey) \(.name)"' > /etc/wireguard/peer-names
EOF
chmod 700 /usr/local/sbin/wg-render.sh
/usr/local/sbin/wg-render.sh
systemctl enable --now wg-quick@wg0

# ---- WireGuard has no connection log: record per-peer handshake state every minute ----
install -d /var/log/wireguard
cat > /usr/local/sbin/wg-peer-log.sh <<'EOF'
#!/bin/bash
# One line per peer: time, peer name, endpoint, seconds since last handshake, rx/tx bytes.
NOW=$(date +%s)
wg show wg0 dump | tail -n +2 | while read -r pub _psk endpoint _ips handshake rx tx _ka; do
  name=$(awk -v k="$pub" '$1==k {print $2}' /etc/wireguard/peer-names)
  if [ "$handshake" = "0" ]; then age=never; else age=$((NOW - handshake)); fi
  echo "$(date -u +%FT%TZ) peer=${name:-unknown} endpoint=$endpoint handshake_age_s=$age rx=$rx tx=$tx"
done >> /var/log/wireguard/peers.log
EOF
chmod 755 /usr/local/sbin/wg-peer-log.sh
cat > /etc/systemd/system/wg-peer-log.service <<'EOF'
[Unit]
Description=Record WireGuard peer state

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/wg-peer-log.sh
EOF
cat > /etc/systemd/system/wg-peer-log.timer <<'EOF'
[Unit]
Description=Record WireGuard peer state every minute

[Timer]
OnCalendar=minutely

[Install]
WantedBy=timers.target
EOF

retry curl -fsSL -o /tmp/cwagent.deb https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb
dpkg -i /tmp/cwagent.deb
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<EOF
{
  "agent": { "region": "$REGION" },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          { "file_path": "/var/log/wireguard/peers.log", "log_group_name": "$LOG_GROUP", "log_stream_name": "{instance_id}/peers.log" }
        ]
      }
    }
  }
}
EOF

systemctl daemon-reload
systemctl enable --now wg-peer-log.timer
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
