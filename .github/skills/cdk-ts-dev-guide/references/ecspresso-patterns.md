# CDK + ecspresso 連携パターン

CDK は ECS のインフラ基盤のみ管理し、タスク定義・サービスの作成/更新は ecspresso に委任するパターン。

---

## 1. 責務分担

| 責務 | 管理者 |
|------|--------|
| ECS Cluster・SG・IAM Role・ECR・CW Logs | CDK |
| SSM Parameter Store 出力 | CDK |
| Auto Scaling（ScalableTarget・ScalingPolicy） | CDK |
| タスク定義の登録（毎 deploy） | ecspresso |
| サービスの Create/Update（upsert） | ecspresso |
| ALB TargetGroup へのアタッチ | ecspresso |
| イメージ URI | ecspresso（jsonnet の外部変数） |

### CDK が作成しないもの

```typescript
// ❌ CDK で TaskDefinition / Service を作成しない
// template.resourceCountIs('AWS::ECS::TaskDefinition', 0);
// template.resourceCountIs('AWS::ECS::Service', 0);
```

---

## 2. CDK 側の実装（EcsConstruct）

### Cluster のみ作成

```typescript
export class EcsConstruct extends Construct {
  public readonly cluster: ecs.ICluster;
  public readonly ecsSg: ec2.ISecurityGroup;
  public readonly ecrRepository: ecr.IRepository;

  constructor(scope: Construct, id: string, props: EcsConstructProps) {
    super(scope, id);
    const { project, environment, vpc, params } = props;
    const clusterName = `${project}-${environment}-api-cluster`;
    const ecsServiceName = `${project}-${environment}-api`;

    // ECR リポジトリ
    this.ecrRepository = new ecr.Repository(this, 'EcrRepository', {
      repositoryName: `${project}-${environment}-api`.toLowerCase(),
      imageScanOnPush: true,
    });

    // Security Group
    const ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc, allowAllOutbound: false,
    });
    ecsSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS outbound');
    this.ecsSg = ecsSg;

    // CloudWatch Logs（ecspresso の awslogs-group と一致させる）
    new logs.LogGroup(this, 'ContainerLogGroup', {
      logGroupName: `/ecs/${project}-${environment}-api`,
      retention: params.ecsLogRetentionDays,
    });

    // ECS Cluster（TaskDefinition / Service は作成しない）
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName, vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // IAM Role: Task Execution Role
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // IAM Role: Task Role
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // SSM Parameter Store 出力（ecspresso が参照）
    const ssmPrefix = `/${project}/${environment}`;
    new ssm.StringParameter(this, 'ClusterArnParam', {
      parameterName: `${ssmPrefix}/ecs/cluster-arn`,
      stringValue: this.cluster.clusterArn,
    });
    new ssm.StringParameter(this, 'TaskExecutionRoleArnParam', {
      parameterName: `${ssmPrefix}/ecs/task-execution-role-arn`,
      stringValue: taskExecutionRole.roleArn,
    });
    new ssm.StringParameter(this, 'TaskRoleArnParam', {
      parameterName: `${ssmPrefix}/ecs/task-role-arn`,
      stringValue: taskRole.roleArn,
    });

    // Auto Scaling（ecspresso 初回デプロイ後に有効化）
    if (params.enableAutoScaling) {
      const scalableTarget = new appscaling.ScalableTarget(this, 'ScalableTarget', {
        serviceNamespace: appscaling.ServiceNamespace.ECS,
        resourceId: `service/${clusterName}/${ecsServiceName}`,
        scalableDimension: 'ecs:service:DesiredCount',
        minCapacity: params.ecsMinTaskCount,
        maxCapacity: params.ecsMaxTaskCount,
      });
      scalableTarget.scaleToTrackMetric('CpuScaling', { ... });
    }
  }
}
```

### 重要: Auto Scaling の有効化タイミング

```
1. enableAutoScaling: false で CDK デプロイ
2. ecspresso で初回サービスデプロイ（サービスが存在する状態にする）
3. enableAutoScaling: true に変更して CDK 再デプロイ
```

ECS サービスが存在しない状態で ScalableTarget を作成すると CloudFormation エラーになる。

---

## 3. ecspresso 側のファイル構成

```text
app/<app-name>/ecspresso/
├── ecspresso.yml           # ecspresso 設定
├── config.jsonnet          # 共通設定（外部変数・SSM 参照）
├── ecs-task-def.jsonnet    # タスク定義
├── ecs-service-def.jsonnet # サービス定義
└── service.jsonnet         # ecspresso v2 サービス設定
```

### ecspresso.yml

```yaml
region: '{{ must_env "AWS_REGION" }}'
cluster: '{{ must_env "CLUSTER_ARN" }}'
service: '{{ must_env "PROJECT" }}-{{ must_env "ENV" }}-api'
service_definition: ecs-service-def.jsonnet
task_definition: ecs-task-def.jsonnet
```

### config.jsonnet（SSM 参照の中核）

```jsonnet
local ssm = std.native('ssm');

local project = std.extVar('PROJECT');
local env = std.extVar('ENV');
local pathPrefix = '/' + project + '/' + env;

{
  project: project,
  env: env,
  // SSM Parameter Store からの値取得
  generateSSMPath(ssmPath):: ssm(pathPrefix + ssmPath),
}
```

### ecs-task-def.jsonnet

```jsonnet
local config = import 'config.jsonnet';

{
  family: config.application,
  cpu: config.cpu,
  memory: config.memory,
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  // CDK が SSM に出力した Role ARN を参照
  executionRoleArn: config.generateSSMPath('/ecs/task-execution-role-arn'),
  taskRoleArn: config.generateSSMPath('/ecs/task-role-arn'),
  containerDefinitions: [{
    name: 'api',
    image: config.image,
    portMappings: [{ containerPort: config.containerPort }],
    logConfiguration: {
      logDriver: 'awslogs',
      options: {
        'awslogs-group': '/ecs/' + config.application,
        'awslogs-region': config.region,
        'awslogs-stream-prefix': 'api',
      },
    },
  }],
}
```

### ecs-service-def.jsonnet

```jsonnet
local config = import 'config.jsonnet';

{
  desiredCount: std.parseInt(config.desiredCount),
  launchType: 'FARGATE',
  networkConfiguration: {
    awsvpcConfiguration: {
      // CDK が SSM に出力したサブネット・SG を参照
      subnets: std.split(config.generateSSMPath('/network/subnet-ids'), ','),
      securityGroups: [config.generateSSMPath('/network/security-group-id')],
      assignPublicIp: 'DISABLED',
    },
  },
  loadBalancers: [{
    targetGroupArn: config.generateSSMPath('/alb/target-group-arn'),
    containerName: 'api',
    containerPort: config.containerPort,
  }],
  deploymentConfiguration: {
    maximumPercent: 200,
    minimumHealthyPercent: 100,
    deploymentCircuitBreaker: { enable: true, rollback: true },
  },
}
```

---

## 4. SSM キー設計（CDK → ecspresso の橋渡し）

| SSM キー | 出力元 | 参照先 |
|---------|--------|--------|
| `/<project>/<env>/ecs/cluster-arn` | EcsConstruct | ecspresso.yml / buildspec |
| `/<project>/<env>/ecs/cluster-name` | EcsConstruct | buildspec |
| `/<project>/<env>/ecs/service-name` | EcsConstruct | buildspec |
| `/<project>/<env>/ecs/task-execution-role-arn` | EcsConstruct | ecs-task-def.jsonnet |
| `/<project>/<env>/ecs/task-role-arn` | EcsConstruct | ecs-task-def.jsonnet |
| `/<project>/<env>/network/subnet-ids` | VpcConstruct | ecs-service-def.jsonnet |
| `/<project>/<env>/network/security-group-id` | EcsConstruct | ecs-service-def.jsonnet |
| `/<project>/<env>/alb/target-group-arn` | AlbConstruct | ecs-service-def.jsonnet |

---

## 5. buildspec での ecspresso 実行

```yaml
# buildspec-deploy.yml
phases:
  install:
    commands:
      - curl -sL https://github.com/kayac/ecspresso/releases/latest/download/ecspresso_linux_amd64.tar.gz | tar xz
  pre_build:
    commands:
      # SSM から値を取得して環境変数に設定
      - export CLUSTER_ARN=$(aws ssm get-parameter --name "/${PROJECT}/${ENV}/ecs/cluster-arn" --query 'Parameter.Value' --output text)
      - export CLUSTER_NAME=$(aws ssm get-parameter --name "/${PROJECT}/${ENV}/ecs/cluster-name" --query 'Parameter.Value' --output text)
  build:
    commands:
      - ./ecspresso deploy --config ecspresso/ecspresso.yml
        --ext-str PROJECT=${PROJECT}
        --ext-str ENV=${ENV}
        --ext-str AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID}
        --ext-str AWS_REGION=${AWS_DEFAULT_REGION}
        --ext-str IMAGE_TAG=${IMAGE_TAG}
        --ext-str TASK_CPU=${TASK_CPU}
        --ext-str TASK_MEMORY=${TASK_MEMORY}
```

---

## 6. よくある落とし穴

| 問題 | 対策 |
|------|------|
| CDK の `cluster.clusterName` が `Fn::Join` トークンになる | リテラル文字列で名前を構築: `` `${project}-${env}-api-cluster` `` |
| CW Logs グループ名が ecspresso と不一致 | CDK 側で `/ecs/${project}-${env}-api` を明示的に作成 |
| Auto Scaling を先に作成して CFn エラー | `enableAutoScaling` フラグで制御、ecspresso 初回デプロイ後に有効化 |
| ecspresso verify で CW Logs 権限不足 | TaskExecutionRole に `/ecs/${project}-${env}-*` の CreateLogStream を追加 |

---

## 7. ADOT サイドカーパターン（AWS Distro for OpenTelemetry）

ADOT Collector をサイドカーとして ECS タスクに追加し、OTLP でトレース・メトリクスを X-Ray / CloudWatch に送信する。

### 構成

```text
ECS Task
├── api コンテナ（アプリ）
│   └── OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
└── aws-otel-collector コンテナ（サイドカー）
    ├── OTLP gRPC :4317 で受信
    ├── → X-Ray（トレース）
    └── → CloudWatch EMF（メトリクス）
```

### CDK 側（enableAdot フラグで制御）

```typescript
// lib/types/api-relay.types.ts
export interface ApiRelayParams {
  readonly enableAdot?: boolean;
  // ...
}

// lib/constructs/ecs-construct.ts
if (params.enableAdot) {
  // ADOT 用 LogGroup
  new logs.LogGroup(this, 'AdotLogGroup', {
    logGroupName: `/ecs/${project}-${environment}-api/otel`,
  });
  new logs.LogGroup(this, 'AdotMetricsLogGroup', {
    logGroupName: `/ecs/${project}-${environment}-api/otel-metrics`,
  });

  // X-Ray 書き込み権限
  taskRole.addToPolicy(new iam.PolicyStatement({
    actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords',
             'xray:GetSamplingRules', 'xray:GetSamplingTargets'],
    resources: ['*'],
  }));
  // CloudWatch メトリクス書き込み権限
  taskRole.addToPolicy(new iam.PolicyStatement({
    actions: ['cloudwatch:PutMetricData'],
    resources: ['*'],
  }));
  // ADOT ログ書き込み権限
  taskRole.addToPolicy(new iam.PolicyStatement({
    actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:CreateLogGroup'],
    resources: [`arn:aws:logs:${region}:${account}:log-group:/ecs/${project}-${env}-api/otel*:*`],
  }));
}
```

### ecspresso 側（条件付きサイドカー追加）

```jsonnet
// config.jsonnet
local enableAdot = std.extVar('ENABLE_ADOT');
{ enableAdot: enableAdot == 'true' }

// ecs-task-def.jsonnet
local adot = import 'side-car-container/adot.jsonnet';
{
  containerDefinitions: [
    { name: 'api', /* ... */
      environment: [/* ... */]
        + (if config.enableAdot then [
          { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://localhost:4317' },
          { name: 'OTEL_SERVICE_NAME', value: config.application },
        ] else []),
    },
  ] + (if config.enableAdot then [adot] else []),
}
```

### adot.jsonnet（サイドカー定義）

```jsonnet
{
  name: 'aws-otel-collector',
  image: 'public.ecr.aws/aws-observability/aws-otel-collector:latest',
  essential: false,
  command: ['--config=/etc/ecs/ecs-default-config.yaml'],
  environment: [
    { name: 'AOT_CONFIG_CONTENT', value: /* YAML 文字列で OTel Collector 設定 */ },
  ],
  portMappings: [
    { containerPort: 4317, protocol: 'tcp' },  // OTLP gRPC
    { containerPort: 4318, protocol: 'tcp' },  // OTLP HTTP
  ],
  healthCheck: {
    command: ['CMD-SHELL', 'curl -f http://localhost:13133/ || exit 1'],
    interval: 30, timeout: 5, retries: 3, startPeriod: 15,
  },
}
```

### OTel Collector 設定（AOT_CONFIG_CONTENT）

```yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }
processors:
  batch: { timeout: 5s, send_batch_size: 256 }
  resource:
    attributes:
      - { key: service.name, value: <application>, action: upsert }
exporters:
  awsxray: { region: <region> }
  awsemf:
    region: <region>
    namespace: <application>
    log_group_name: /ecs/<application>/otel-metrics
service:
  pipelines:
    traces:  { receivers: [otlp], processors: [batch, resource], exporters: [awsxray] }
    metrics: { receivers: [otlp], processors: [batch, resource], exporters: [awsemf] }
```
