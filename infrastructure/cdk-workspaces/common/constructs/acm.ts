import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from 'constructs';
import { C_RESOURCE } from "@common/constants";

interface AcmProps {
  readonly hostedZone: route53.IHostedZone;
  readonly domainName: string;
}

export class AcmConstruct extends Construct {
  public readonly certificate: acm.ICertificate;

    constructor(scope: Construct, id: string, props: AcmProps) {
        super(scope, id);
        const commonName = `*.${props.domainName}`;
        this.certificate = new acm.Certificate(this, C_RESOURCE, {
            domainName: props.domainName,
            validation: acm.CertificateValidation.fromDns(props.hostedZone),
            subjectAlternativeNames: [commonName],
        });
    }
}