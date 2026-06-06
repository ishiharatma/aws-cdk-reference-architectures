import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { Environment } from "../parameters/environments";
import { C_RESOURCE } from '../constants';

interface AlbProps {
    readonly project: string;
    readonly environment: Environment;
    readonly vpc: ec2.IVpc;
    readonly securityGroup: ec2.ISecurityGroup;
    readonly accessLogsBucket?: s3.IBucket;
    readonly certificate?: elbv2.IListenerCertificate;
    readonly loadBalancerName?: string;
    readonly isALBOpen: boolean;
}

export class AlbConstruct extends Construct {
    public readonly alb: elbv2.IApplicationLoadBalancer;
    public readonly listener: elbv2.IApplicationListener;

    constructor(scope: Construct, id: string, props: AlbProps) {
        super(scope, id);

        const albPort = props.certificate ? 443 : 80;
        const albProtocol = props.certificate ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP;
        // Create the Application Load Balancer
        const alb = new elbv2.ApplicationLoadBalancer(this, C_RESOURCE, {
            vpc: props.vpc,
            securityGroup: props.securityGroup,
            internetFacing: true,
            loadBalancerName: props.loadBalancerName,
        });
        this.alb = alb;
        // Output ALB DNS Name
        new cdk.CfnOutput(this, 'AlbDnsName', {
            value: alb.loadBalancerDnsName,
            description: 'The DNS name of the Application Load Balancer',
        });
        new cdk.CfnOutput(this, 'AlbArn', {
            value: alb.loadBalancerArn,
            description: 'The ARN of the Application Load Balancer',
        });

        // Enable access logging if a bucket is provided
        if (props.accessLogsBucket) {
            alb.logAccessLogs(props.accessLogsBucket, 'alb-access-logs');
        }

        const httpListener = alb.addListener('HttpListener', {
            port: 80,
            open: props.isALBOpen,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: props.certificate ? elbv2.ListenerAction.redirect({  
                protocol: 'HTTPS',
                port: '443',
                permanent: true,
            }) : elbv2.ListenerAction.fixedResponse(404, {
                contentType: 'text/plain',
                messageBody: 'Not Found',
            }),
        });

        // Create a listener on port 443 (HTTPS)
        if (props.certificate) {
            const httpsListener = alb.addListener('HttpsListener', {
                port: albPort,
                open: true,
                protocol: albProtocol,
                sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
                certificates: [props.certificate],
                defaultAction: elbv2.ListenerAction.fixedResponse(404, {  
                    contentType: 'text/plain',
                    messageBody: 'Not Found',
                }),
            });
            this.listener = httpsListener;
        } else {
            this.listener = httpListener;
        }
    }
}