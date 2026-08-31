/**
 * Returns user data commands that install and configure BIND9 on Amazon Linux 2023 as a
 * minimal on-premises-role DNS forwarder.
 *
 * Unlike an authoritative server, this instance holds no zone data of its own. It forwards
 * every query under `zoneName` to `forwarderIps` (HubVpc's regular inbound Resolver endpoint)
 * and lets Route 53 Resolver's `DELEGATE` rules transparently continue the query down into
 * whichever child private hosted zone actually owns the name - no per-child conditional
 * forwarder is configured here, which is the point of the feature being demonstrated.
 */
export function bind9ForwarderUserData(zoneName: string, forwarderIps: string[]): string[] {
    const forwarders = forwarderIps.map((ip) => `        ${ip};`).join('\n');

    return [
        'dnf install -y bind bind-utils',

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
        '    type forward;',
        '    forward only;',
        '    forwarders {',
        forwarders,
        '    };',
        '};',
        'NAMEDCONFEOF',

        'named-checkconf',

        'systemctl enable named',
        'systemctl restart named',
    ];
}
