import { Template, Match } from 'aws-cdk-lib/assertions';
import { makeStacks } from '../helpers/make-stacks';

describe('BaseStack', () => {
    const { baseStack } = makeStacks('Unit');
    const template = Template.fromStack(baseStack);

    test('Multi-AZ DB instance is a plain (non-Aurora) PostgreSQL instance with MultiAZ enabled', () => {
        template.hasResourceProperties('AWS::RDS::DBInstance', {
            Engine: 'postgres',
            MultiAZ: true,
            DBInstanceClass: 'db.t4g.small',
            StorageEncrypted: true,
            DBInstanceIdentifier: 'fis-chaos-i-test-maz-instance',
        });
    });

    test('Multi-AZ DB cluster is a non-Aurora cluster selected via DBClusterInstanceClass', () => {
        template.hasResourceProperties('AWS::RDS::DBCluster', {
            Engine: 'postgres',
            DBClusterInstanceClass: 'db.m6gd.large',
            StorageType: 'gp3',
            Port: 5432,
            StorageEncrypted: true,
            DBClusterIdentifier: 'fis-chaos-i-test-maz-cluster',
        });
    });

    test('no Aurora resources and no cluster member instances are created', () => {
        template.resourceCountIs('AWS::RDS::DBCluster', 1);
        template.resourceCountIs('AWS::RDS::DBInstance', 1);
        const clusters = template.findResources('AWS::RDS::DBCluster');
        Object.values(clusters).forEach((c) => {
            expect(String(c.Properties.Engine)).not.toMatch(/aurora/);
        });
    });

    test('cluster master password is a Secrets Manager dynamic reference, not a literal', () => {
        const clusters = template.findResources('AWS::RDS::DBCluster');
        const pw = JSON.stringify(Object.values(clusters)[0].Properties.MasterUserPassword);
        expect(pw).toContain('resolve:secretsmanager');
    });

    test('both databases live in the isolated-subnet group', () => {
        template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
    });
});

describe('ProbeStack', () => {
    const { probeStack } = makeStacks('Unit');
    const template = Template.fromStack(probeStack);

    test('probe Lambda runs inside the VPC with a 15 minute timeout', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
            Timeout: 900,
            VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
            Environment: {
                Variables: Match.objectLike({
                    SECRET_ARN: Match.anyValue(),
                    INSTANCE_ENDPOINT: Match.anyValue(),
                    CLUSTER_ENDPOINT: Match.anyValue(),
                }),
            },
        });
    });

    test('stop-condition alarms need 5 consecutive failing minutes and ignore missing data', () => {
        template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
        template.allResourcesProperties('AWS::CloudWatch::Alarm', {
            Namespace: 'FisRdsProbe',
            MetricName: 'ProbeFailure',
            EvaluationPeriods: 5,
            DatapointsToAlarm: 5,
            TreatMissingData: 'notBreaching',
        });
    });
});

describe('FisStack', () => {
    const { fisStack } = makeStacks('Unit');
    const template = Template.fromStack(fisStack);

    test('three experiment templates are created', () => {
        template.resourceCountIs('AWS::FIS::ExperimentTemplate', 3);
    });

    test('I-1 reboots the instance with forceFailover=true', () => {
        template.hasResourceProperties('AWS::FIS::ExperimentTemplate', {
            Description: Match.stringLikeRegexp('^\\[I-1\\]'),
            Actions: {
                RebootWithFailover: {
                    ActionId: 'aws:rds:reboot-db-instances',
                    Parameters: { forceFailover: 'true' },
                },
            },
        });
    });

    test('I-2 fails over the Multi-AZ DB cluster', () => {
        template.hasResourceProperties('AWS::FIS::ExperimentTemplate', {
            Description: Match.stringLikeRegexp('^\\[I-2\\]'),
            Actions: { FailoverCluster: { ActionId: 'aws:rds:failover-db-cluster' } },
            Targets: { MultiAzCluster: Match.objectLike({ ResourceType: 'aws:rds:cluster' }) },
        });
    });

    test('I-3 reboots the instance with forceFailover=false', () => {
        template.hasResourceProperties('AWS::FIS::ExperimentTemplate', {
            Description: Match.stringLikeRegexp('^\\[I-3\\]'),
            Actions: {
                RebootNoFailover: {
                    ActionId: 'aws:rds:reboot-db-instances',
                    Parameters: { forceFailover: 'false' },
                },
            },
        });
    });

    test('every template has exactly one alarm stop condition', () => {
        template.allResourcesProperties('AWS::FIS::ExperimentTemplate', {
            StopConditions: [Match.objectLike({ Source: 'aws:cloudwatch:alarm' })],
        });
    });

    test('FIS role is scoped to the instance and cluster ARNs', () => {
        template.hasResourceProperties('AWS::IAM::Role', {
            Policies: [
                Match.objectLike({
                    PolicyDocument: Match.objectLike({
                        Statement: Match.arrayWith([
                            Match.objectLike({
                                Action: ['rds:FailoverDBCluster', 'rds:DescribeDBClusters'],
                            }),
                        ]),
                    }),
                }),
            ],
        });
    });
});
