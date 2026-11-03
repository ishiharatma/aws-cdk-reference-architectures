# Remote-Access VPN on AWS — AWS Client VPN vs OpenVPN vs WireGuard on EC2

Verified while deploy-verifying `client-vpn-vs-openvpn-wireguard` (ap-northeast-1, aws-cdk-lib 2.273,
November 2026). The client was an Ubuntu 24.04 t4g.micro in an unrelated VPC reaching all three servers over
the internet; the servers were Ubuntu 24.04 (t4g.micro for OpenVPN, t4g.nano for WireGuard).

## WireGuard on EC2: pin the tunnel MTU to 1420

EC2 ENIs have a 9001-byte MTU, and `wg-quick` sets the tunnel MTU to the route MTU minus 80, so `wg0` came up
with **MTU 8921** on both the server and the client instance. The internet path between them is 1500 bytes, so
every large tunnel packet is fragmented. Measured HTTP download through the tunnel (100 MiB, 3 runs):

| Tunnel MTU | Throughput |
| --- | --- |
| 8921 (wg-quick default on EC2) | 41–81 Mbit/s |
| 1420 (`MTU = 1420` in `[Interface]`) | 1,674–2,248 Mbit/s |

Set `MTU = 1420` in the server config and in every client config that may run on a jumbo-frame network.
Laptops on 1500-byte networks get 1420 automatically; the trap only bites when one side is an EC2 instance
(including a test client). OpenVPN did not show this: its `tun0` stays at 1500 and it clamps TCP MSS itself.

## The snap AWS CLI writes nothing when stdout is redirected to a file under SSM Run Command

On Ubuntu 24.04 (`snap install aws-cli --classic`, CLI 2.35.21), inside an `AWS-RunShellScript` command,
`aws ec2 export-client-vpn-client-configuration ... --output text > file` exited 0 and produced a **0-byte
file** — the same happened for `--query ... > file`. `$(aws ...)` and `aws ... | cat > file` worked. Pipe the
output (`| cat > file`) in user data and Run Command scripts that use the snap CLI.

## How each method rejects a user, and what each side sees

| Method | Mechanism used | Client sees | Server-side record |
| --- | --- | --- | --- |
| Client VPN | Client connect handler Lambda (`allow: false`) | `AUTH_FAILED,<error-msg-on-denied-connection>` about 1 s after TLS, then `openvpn` exits | Handler's own log line; `describe-client-vpn-connections` shows the attempt as `terminated` |
| OpenVPN | `crl-verify` with the client certificate revoked | Nothing explicit: `TLS key negotiation failed to occur within 60 seconds`, retried forever | `VERIFY ERROR: depth=0, error=certificate revoked: CN=...` in `server.log` |
| WireGuard | Public key not in the peer list | Nothing: no handshake, `transfer: 0 B received` | Nothing at all — WireGuard does not answer or log unknown peers |

- The Client VPN connect handler runs after TLS, so the user gets a readable reason (the
  `error-msg-on-denied-connection` string) and the decision can use the CN, public IP, platform and client
  version. Its function name must start with `AWSClientVPN-`; no resource policy is needed.
- OpenVPN rejects **every** client once the CRL passes its `nextUpdate` (`default_crl_days` in `openssl ca`,
  30 days by default). Generate the CRL with a long validity and renew it on a schedule.
- WireGuard has no notion of a session: after the client disconnects, `wg show` keeps the last endpoint and
  the "latest handshake" just ages. "Connected" has to be inferred from handshake age (< ~3 minutes).

## Source address the target sees

All three were set up to source-NAT into the VPC, so the target never sees the client tunnel address:
Client VPN (VPC association) → the endpoint ENI's private IP in the associated subnet; OpenVPN / WireGuard
with `MASQUERADE` → the server's private IP. Because of the NAT, the self-hosted servers keep source/destination
check enabled and need no route table changes. Security groups on the target can therefore reference each VPN's
security group (the Client VPN endpoint's group applies to its ENIs).

## Client VPN facts

- **The connection log is delivered in batches, minutes late.** Connections at 03:04–03:07 appeared in
  CloudWatch Logs together at 03:30:35; until then the log stream named in `ConnectionLogOptions` did not exist
  (`describe-log-streams` returned nothing). The AWS VPN FAQ calls the export "best effort … at 15 minute
  intervals". A connect-handler denial is logged as `connection-attempt-status: failed`,
  `connection-attempt-failure-reason: client-connect-failed`. For near-real-time data use the handler's own log
  or `describe-client-vpn-connections`.
- Deploy time: the endpoint itself was created in ~76 s, but the two subnet associations took **7 min 17 s**
  (both in parallel); the whole stack 9 min 10 s. The self-hosted stacks took ~3 min.
- Delete time: the Client VPN stack took ~10 min (subnet disassociation); the ACM certificate can only be deleted
  after that.
- The server certificate must be in ACM even for mutual authentication; a client certificate issued by the
  same CA can use the server certificate ARN as `ClientRootCertificateChainArn`. Only 1024/2048-bit RSA keys.
- `export-client-vpn-client-configuration` returns a profile with `remote cvpn-endpoint-....prod.clientvpn.<region>.amazonaws.com 443`,
  `remote-random-hostname`, `verify-x509-name` and the CA; append `<cert>` / `<key>` and stock OpenVPN 2.6
  connects.
- Pricing (ap-northeast-1, Pricing API): $0.15 per association-hour, $0.05 per connection-hour. The ENIs in a
  VPC with an internet gateway get public IPv4 addresses that are billed as well.

## CDK notes

- `Aspects.of(app)` does not reach stacks inside a `Stage`; apply `AwsSolutionsChecks` to the stage in tests.
- `ec2.ClientVpnEndpoint` (L2) takes `clientConnectionHandler` as any function with `functionArn`; it creates
  the `AuthorizeAll` rule for the VPC CIDR unless `authorizeAllUsersToVpcCidr: false`. Transit Gateway
  association is only in the L1 (`transitGatewayConfiguration`).
- `MachineImage.fromSsmParameter('/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id')`
  gives Ubuntu, which ships `openvpn` and `wireguard-tools` (Amazon Linux 2023 ships neither). The root device
  is `/dev/sda1`.
- An Elastic IP declared with `CfnEIP({ instanceId })` kept its address when user data changes replaced the
  instance (`userDataCausesReplacement: true`), so client configs survive server replacement.
