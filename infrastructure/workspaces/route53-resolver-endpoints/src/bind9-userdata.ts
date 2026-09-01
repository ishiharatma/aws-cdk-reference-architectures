/**
 * BIND9 conditional-forwarder configuration: a `zone { type forward; }` block for a domain
 * this instance is not authoritative for, pointing at the given resolver IPs.
 */
export interface Bind9ForwardZoneConfig {
    /** Domain to forward - typically the Route 53 private hosted zone name. */
    readonly zoneName: string;
    /** Target IPs to forward to, e.g. the Resolver inbound endpoint's static IPs. */
    readonly forwarderIps: string[];
}

/**
 * Returns user data commands that install and configure BIND9 on Amazon Linux 2023 as a
 * minimal on-premises-role DNS server.
 *
 * The server is authoritative for `zoneName` and answers one static A record, so the
 * Resolver outbound endpoint's FORWARD rule has something to prove: querying
 * `<hostRecordName>.<zoneName>` from the verification VPC should resolve to this
 * instance's own private IP.
 *
 * When `forwardZone` is given, the server also gets a conditional forwarder - a second
 * `zone { type forward; }` block - so it can act as the *querying* side of the inbound
 * endpoint too: `dig @127.0.0.1 <name>.<forwardZone.zoneName>` from this instance exercises
 * the full on-premises-resolver round trip through the inbound endpoint, not just a raw
 * `dig` against the endpoint's IP.
 */
export function bind9UserData(zoneName: string, hostRecordName = 'host1', forwardZone?: Bind9ForwardZoneConfig): string[] {
    const zoneFile = `/var/named/${zoneName}.zone`;

    const forwardZoneBlock = forwardZone
        ? [
              `zone "${forwardZone.zoneName}" IN {`,
              '    type forward;',
              '    forward only;',
              '    forwarders {',
              ...forwardZone.forwarderIps.map((ip) => `        ${ip};`),
              '    };',
              '};',
          ]
        : [];

    return [
        'dnf install -y bind bind-utils',

        // IMDSv2 token + this instance's own private IP, used as the demo A record's target.
        'TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
        'PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)',

        // Listen on all interfaces, allow queries and recursion only from RFC1918 space
        // (this is a demo on-premises stand-in, not a hardened resolver).
        'cat > /etc/named.conf << \'NAMEDCONFEOF\'',
        'options {',
        '    listen-on port 53 { any; };',
        '    listen-on-v6 port 53 { none; };',
        '    directory "/var/named";',
        '    allow-query { 10.0.0.0/8; 127.0.0.1; };',
        '    recursion yes;',
        '    dnssec-validation no;',
        '};',
        `zone "${zoneName}" IN {`,
        '    type master;',
        `    file "${zoneFile}";`,
        '    allow-update { none; };',
        '};',
        ...forwardZoneBlock,
        'NAMEDCONFEOF',

        `cat > ${zoneFile} << ZONEEOF`,
        // Escaped: in this unquoted heredoc (needed so ${PRIVATE_IP} below expands),
        // bash would otherwise treat BIND's "$TTL" directive as an unset shell variable
        // and silently strip it, corrupting the zone file's first line.
        '\\$TTL 300',
        `@ IN SOA ns.${zoneName}. admin.${zoneName}. ( 1 3600 900 604800 300 )`,
        `@ IN NS ns.${zoneName}.`,
        `ns.${zoneName}. IN A \${PRIVATE_IP}`,
        `${hostRecordName}.${zoneName}. IN A \${PRIVATE_IP}`,
        'ZONEEOF',

        // ZONEEOF above is unquoted so ${PRIVATE_IP} expands; fix ownership after the fact.
        'chown named:named ' + zoneFile,
        'chmod 640 ' + zoneFile,

        'named-checkconf',
        `named-checkzone ${zoneName} ${zoneFile}`,

        'systemctl enable named',
        'systemctl restart named',
    ];
}
