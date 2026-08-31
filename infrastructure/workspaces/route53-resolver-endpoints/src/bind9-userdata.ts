/**
 * Returns user data commands that install and configure BIND9 on Amazon Linux 2023 as a
 * minimal on-premises-role authoritative DNS server.
 *
 * The zone answers one static A record so the Resolver outbound endpoint's FORWARD rule
 * has something to prove: querying `<hostRecordName>.<zoneName>` from the verification
 * VPC should resolve to this instance's own private IP.
 */
export function bind9UserData(zoneName: string, hostRecordName = 'host1'): string[] {
    const zoneFile = `/var/named/${zoneName}.zone`;

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
