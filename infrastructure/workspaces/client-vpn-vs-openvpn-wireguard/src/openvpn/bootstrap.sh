#!/bin/bash
# OpenVPN community server bootstrap (Ubuntu 24.04). Placeholders @@...@@ are filled by CDK.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# The Elastic IP replaces the launch-time public IP a few seconds after boot, which drops any
# connection in flight; retry every network step instead of failing the whole bootstrap.
retry() { for i in $(seq 1 10); do "$@" && return 0; sleep 15; done; return 1; }

REGION='@@REGION@@'
SECRET_ID='@@SECRET_ID@@'
PORT='@@PORT@@'
TUNNEL_NETWORK='@@TUNNEL_NETWORK@@'
TUNNEL_NETMASK='@@TUNNEL_NETMASK@@'
TUNNEL_CIDR='@@TUNNEL_CIDR@@'
VPC_NETWORK='@@VPC_NETWORK@@'
VPC_NETMASK='@@VPC_NETMASK@@'
LOG_GROUP='@@LOG_GROUP@@'

retry apt-get -o DPkg::Lock::Timeout=600 update
retry apt-get -o DPkg::Lock::Timeout=600 install -y openvpn jq
retry snap install aws-cli --classic

# ---- certificates (created by setup-pki.sh; never part of the template) ----
# 755: the worker re-reads crl.pem as "nobody" after dropping privileges; only key.pem is 600.
install -d -m 755 /etc/openvpn/server
# No xtrace while key material is in variables (it would land in cloud-init-output.log).
set +x
SECRET_JSON=$(/snap/bin/aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text)
for f in ca cert key crl; do
  echo "$SECRET_JSON" | jq -r ".$f" > "/etc/openvpn/server/$f.pem"
done
chmod 600 /etc/openvpn/server/key.pem
# The CRL is read by the unprivileged worker after the privilege drop.
chmod 644 /etc/openvpn/server/crl.pem
unset SECRET_JSON
set -x

install -d /var/log/openvpn
cat > /etc/openvpn/server/server.conf <<EOF
port $PORT
proto udp
dev tun
topology subnet
server $TUNNEL_NETWORK $TUNNEL_NETMASK
# Split tunnel: only the VPC is routed through the VPN (same as Client VPN split-tunnel).
push "route $VPC_NETWORK $VPC_NETMASK"
ca /etc/openvpn/server/ca.pem
cert /etc/openvpn/server/cert.pem
key /etc/openvpn/server/key.pem
dh none
ecdh-curve prime256v1
tls-version-min 1.2
data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305
remote-cert-tls client
# Revocation: OpenVPN rejects every client once the CRL passes its nextUpdate, so it must be renewed.
crl-verify /etc/openvpn/server/crl.pem
keepalive 10 60
user nobody
group nogroup
persist-key
persist-tun
explicit-exit-notify 1
status /var/log/openvpn/status.log 30
log-append /var/log/openvpn/server.log
verb 3
EOF

# ---- forwarding + source NAT: VPC resources see the server's private IP, no route table changes ----
cat > /etc/sysctl.d/90-vpn-forward.conf <<'EOF'
net.ipv4.ip_forward = 1
EOF
sysctl --system
cat > /usr/local/sbin/vpn-nat.sh <<EOF
#!/bin/bash
IFACE=\$(ip route show default | awk '{print \$5; exit}')
iptables -t nat -C POSTROUTING -s $TUNNEL_CIDR -o "\$IFACE" -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -s $TUNNEL_CIDR -o "\$IFACE" -j MASQUERADE
EOF
chmod 755 /usr/local/sbin/vpn-nat.sh
cat > /etc/systemd/system/vpn-nat.service <<'EOF'
[Unit]
Description=Source NAT for VPN clients
After=network-online.target
Before=openvpn-server@server.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/vpn-nat.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

# ---- connection log shipping (OpenVPN writes connect / disconnect / TLS errors to server.log) ----
retry curl -fsSL -o /tmp/cwagent.deb https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb
dpkg -i /tmp/cwagent.deb
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<EOF
{
  "agent": { "region": "$REGION" },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          { "file_path": "/var/log/openvpn/server.log", "log_group_name": "$LOG_GROUP", "log_stream_name": "{instance_id}/server.log" }
        ]
      }
    }
  }
}
EOF

systemctl daemon-reload
systemctl enable --now vpn-nat.service
systemctl enable --now openvpn-server@server.service
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
