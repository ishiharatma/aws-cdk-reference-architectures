*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

# EKS 基本構成：Managed Node Group + AWS Load Balancer Controller と EKS Auto Mode の比較 - AWS CDK リファレンスアーキテクチャ

![Level 300](https://img.shields.io/badge/Level-300-orange)
![AWS CDK](https://img.shields.io/badge/AWS%20CDK-2.273-blue)
![Amazon EKS](https://img.shields.io/badge/Amazon%20EKS-1.36-FF9900)

EKS クラスターを初めて作るとき、アプリケーションより先に決めることが 2 つあります。ノードを誰が運用するか、`Ingress` をロードバランサーに変換するのは誰か、です。従来の答えは **Managed Node Group** と、自分でインストールする **AWS Load Balancer Controller**（Helm チャート、IAM ロール、Webhook）の組み合わせです。**EKS Auto Mode** はこの 2 つをクラスター側に取り込みます。EC2 ノードの起動・パッチ適用・削除は EKS が行い、ロードバランサーコントローラーはマネージド機能として動きます。

このアーキテクチャは、同じ Web アプリを Ingress から作られる ALB の背後に置き、両方のクラスターへデプロイします。VPC は 1 つを共有し、`aws-eks-v2`（L1 ベースの `AWS::EKS::Cluster`）を使います。Managed Node Group 側のコントローラーは IRSA ではなく **EKS Pod Identity** で認証します。ap-northeast-1 で両方を実機検証し、次の点を確認しました。

- 各スタックが何を所有するか
- 同じ 3 Pod に何台のノードが要るか
- スケールアウト・スケールインで何が起きるか
- トラフィック中のローリング再起動でエラーが出るか
- デプロイ途中で踏んだ落とし穴

![Architecture](./overview.drawio.svg)

## 📑 目次

- [アーキテクチャ概要](#️-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [検証結果](#-検証結果ap-northeast-1-にデプロイ)
- [Well-Architected との対応](#️-well-architected-との対応)
- [コスト](#-コスト)
- [セキュリティ](#-セキュリティ)
- [前提条件](#-前提条件)
- [デプロイ](#-デプロイ)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#️-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

### 主要コンポーネント

| コンポーネント | Managed Node Group（L-1、`eks-mng`） | Auto Mode（L-2、`eks-auto`） |
| --- | --- | --- |
| キャパシティ設定 | `defaultCapacityType: NODEGROUP`、`defaultCapacity: 0`、ノードグループを明示的に 1 つ定義 | `defaultCapacityType: AUTOMODE`、`compute.nodePools: ['system', 'general-purpose']` |
| ノード | AL2023、`t3.medium`、最小 2 / 希望 2 / 最大 4、20 GiB | Bottlerocket。インスタンスタイプは Pod ごとに選ばれる（実測：`c5a.large`、`c6a.large`） |
| ロードバランサーコントローラー | AWS Load Balancer Controller v3.2.2（Helm）、`kube-system` に 2 レプリカ | 組み込み（`eks.amazonaws.com/alb`）、クラスターの外で動作 |
| コントローラーの認証情報 | **EKS Pod Identity**（関連付け + `eks-pod-identity-agent` アドオン） | クラスター IAM ロール（`AmazonEKSLoadBalancingPolicy`） |
| IngressClass | `alb`（チャートがインストール） | `auto-alb` + `IngressClassParams`（`eks.amazonaws.com/v1`）をスタックで宣言 |
| ALB の設定場所 | Ingress のアノテーション（`scheme`、`target-type`、`inbound-cidrs`） | `IngressClassParams`（`scheme`、`targetType`、`inboundCIDRs`） |
| ネットワーク / DNS / kube-proxy | VPC CNI・CoreDNS・kube-proxy を自前で管理（ブートストラップ時に入る版） | EKS が管理し、`kube-system` に Pod はない |

両クラスター共通の設定（`lib/constructs/cluster-defaults.ts`）：

| 設定 | 値 | 理由 |
| --- | --- | --- |
| Kubernetes バージョン | 1.36 | aws-cdk-lib 2.273 で使える最新版（`KubectlV36Layer`） |
| サブネット | 3 AZ のプライベートサブネット（`/20`）、パブリックは `/24` | Pod が VPC の IP を使うため。ALB のサブネットは `kubernetes.io/role/elb` タグで自動検出される |
| API エンドポイント | パブリック（デプロイした端末の `/32` に限定）+ プライベート | 踏み台なしで手元から kubectl を使える。ノードと kubectl ハンドラーはプライベートエンドポイントを使う |
| Secret | KMS キーによるエンベロープ暗号化（ローテーション有効） | Kubernetes Secret をカスタマー管理キーで暗号化する |
| コントロールプレーンログ | 5 種類すべて。ロググループは **事前作成**、保持 7 日 | 作成しておかないと、EKS が `/aws/eks/<cluster>/cluster` を無期限保持で、スタックの外に作る |
| kubectl ハンドラー | `KubectlV36Layer` を使う Lambda をプライベートサブネットに配置 | `cdk deploy` 中にマニフェストと Helm チャートを適用する |
| 管理者アクセス | `EKS_ADMIN_PRINCIPAL_ARN` に `AmazonEKSClusterAdminPolicy` のアクセスエントリを付与 | クラスターを作るのは CloudFormation 実行ロールなので、人が操作するには明示的なエントリが必要 |

アプリケーション（`src/app.py`、Python 標準ライブラリのみ、`python:3.13-alpine`）は両方で同一です。

- 3 レプリカ。`topology.kubernetes.io/zone` で `topologySpreadConstraints`（`DoNotSchedule`）を指定
- `/health` の Readiness Probe。SIGTERM を受けてから 10 秒間ドレインする
- 非 root、読み取り専用のルートファイルシステム
- 応答として、クラスターの種類・Pod・ノード・AZ を返す

### スタック

| スタック | 内容 | リソース数 |
| --- | --- | --- |
| `<project>-<env>-eks-network` | VPC（3 AZ、NAT ゲートウェイ 1）、サブネットのロールタグ、REJECT のフローログ | 36 |
| `<project>-<env>-eks-mng` | クラスター、ノードグループ、Pod Identity 関連付け + エージェントアドオン、コントローラーの Helm リリース、アプリ | 29 |
| `<project>-<env>-eks-auto` | Auto Mode クラスター、IngressClass + IngressClassParams、アプリ | 23 |

`parameters/` の `managedNodeGroup.enabled` / `autoMode.enabled` で、各クラスターのスタックを個別に無効にできます。

## 🎯 設計判断とベストプラクティス

### 1. `aws-eks` ではなく `aws-eks-v2` を使う

`aws-eks-v2` はクラスターを `aws-eks` のカスタムリソースではなく、ネイティブの `AWS::EKS::Cluster` として作ります。kubectl ハンドラーも任意です。既定のキャパシティタイプが Auto Mode なので、Managed Node Group 側は `defaultCapacityType: NODEGROUP` を明示します。`defaultCapacity: 0` にしてノードグループをクラスターの Construct の外に出し、AMI タイプ・サイズ・スケール範囲がスタック上で見えるようにしています。

```typescript
this.cluster = new eks.Cluster(this, 'Cluster', {
  ...defaults.clusterProps,
  defaultCapacityType: eks.DefaultCapacityType.NODEGROUP,
  defaultCapacity: 0,
});
this.nodeGroup = this.cluster.addNodegroupCapacity('Workers', {
  amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
  instanceTypes: [new ec2.InstanceType('t3.medium')],
  minSize: 2, desiredSize: 2, maxSize: 4,
});
```

Auto Mode 側は、同じ呼び出しを `AUTOMODE` と `compute.nodePools` に置き換えるだけです。

### 2. 組み込みの `albController` ではなく、Pod Identity でコントローラーを入れる

`eks.Cluster` の `albController` オプションは **IRSA** でコントローラーを入れます。IAM OIDC プロバイダーを作り、信頼ポリシーにクラスターの issuer を書いたロールを使う方式です。`AlbControllerPodIdentity`（`lib/constructs/alb-controller-pod-identity.ts`）は同じことを Pod Identity で行います。

- `identityType: POD_IDENTITY` を指定した `eks.ServiceAccount` が、次の 3 つを作ります。OIDC プロバイダーは作られません（unit テストで確認しています）。
  - `pods.eks.amazonaws.com` を信頼するロール（`sts:AssumeRole`、`sts:TagSession`）
  - `AWS::EKS::PodIdentityAssociation`
  - `eks-pod-identity-agent` アドオン
- ロールには v3.2.2 用のアップストリームのコントローラーポリシーを付けます。このポリシーは aws-cdk-lib から `src/` にコピーしてあり、チャートのバージョンとそろえて更新します。
- `eks.HelmChart` が `aws-load-balancer-controller` を `serviceAccount.create: false`、`wait: true` でインストールします。

依存関係は 2 つ手で追加しています。

- **ノードグループへの依存:** エージェントアドオンとチャートは、Ready になるのにノードが必要なので、ノードグループの後に作ります。
- **コントローラーへの依存:** アプリはコントローラーの後に作ります。これはデプロイ時と削除時の両方で効きます。
  - デプロイ時：Service と Ingress を適用する前に、コントローラーのアドミッション Webhook が応答できる状態になっている必要があります。
  - 削除時：Ingress を削除する間もコントローラーが動いていないと、ALB が残ってしまいます。

### 3. Auto Mode は ALB の設定を IngressClassParams から読む

Auto Mode は IngressClass に付けたアノテーションを無視します。クラスター全体の ALB 設定は、`eks.amazonaws.com/v1` の `IngressClassParams` に書きます（OSS 版のコントローラーは `elbv2.k8s.aws/v1beta1` で、フィールド名も異なります）。スタックで 2 つのオブジェクトを宣言し、Ingress から参照します。

```typescript
{ apiVersion: 'eks.amazonaws.com/v1', kind: 'IngressClassParams', metadata: { name: 'auto-alb' },
  spec: { scheme: 'internet-facing', targetType: 'ip', inboundCIDRs: allowedCidrs } },
{ apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', metadata: { name: 'auto-alb' },
  spec: { controller: 'eks.amazonaws.com/alb',
          parameters: { apiGroup: 'eks.amazonaws.com', kind: 'IngressClassParams', name: 'auto-alb' } } },
```

両方のコントローラーが解釈する Ingress 単位のアノテーション（`healthcheck-path`、`target-group-attributes`）は、`WebApp` の Ingress に残しています。

### 4. ワークロードは 1 つの Construct にまとめ、ALB のホスト名をスタック出力にする

Namespace・Deployment・Service・Ingress を定義するのは `WebApp`（`lib/constructs/web-app.ts`）だけです。各スタックは、IngressClass 名と、違いのあるアノテーションだけを渡します。`KubernetesObjectValue` で Ingress の `.status.loadBalancer.ingress[0].hostname` を読み戻すので、`AlbUrl` は通常の CloudFormation 出力になります。

### 5. マニフェストは Construct 自身のスコープで作る

`cluster.addManifest()` や `cluster.addHelmChart()` は、リソースを **クラスターの下** に作ります。そのため `webApp.node.addDependency(controller)` を書いても、そのリソースには依存関係が届きません。そこで各 Construct は `eks.KubernetesManifest` / `eks.HelmChart` / `eks.ServiceAccount` を `this` をスコープにして作ります。こうすると、Construct 単位で付けた依存関係が、配下のすべてのリソースの `DependsOn` になります。

### 6. コントロールプレーンのロググループを事前に作る

ログを有効にすると、EKS は `/aws/eks/<cluster>/cluster` に書き込みます。グループがなければ EKS 自身が作り、保持期間は無期限になります。`ClusterDefaults` はこのグループをスタック内に、保持 7 日・`RemovalPolicy.DESTROY` で作り、クラスターをそれに依存させています。

### 7. VPC は共有し、スタックは分ける

2 つのクラスターで VPC を共有しているので、比較の対象はコンピューティングとロードバランシングだけになります。スタックを分けているので、各クラスターを個別にデプロイ・削除できます（片方だけ使えば費用も半分です）。

## 🔬 検証結果（ap-northeast-1 にデプロイ）

2026-10-29 にデプロイしました。aws-cdk-lib 2.273.0、Kubernetes 1.36、プロファイル `drillexercises-dev`。各項目とも 1 回ずつの計測です。

### 1. デプロイ時間

| ステップ | Managed Node Group | Auto Mode |
| --- | --- | --- |
| `AWS::EKS::Cluster` | 9 分 05 秒 | 10 分 06 秒 |
| ノードグループ | 1 分 20 秒 | — |
| Pod Identity 関連付け + エージェントアドオン | 24 秒 | — |
| 最初のマニフェストが適用されるまでの待ち | ノードグループ作成から 2 分 20 秒 | クラスター作成から 3 分 40 秒 |
| コントローラーの Helm リリース（`wait: true`） | サービスアカウントの 28 秒後 | — |
| ワークロード、Ingress、ALB ホスト名 | 21 秒 | 22 秒 |
| **スタック全体**（`cdk deploy`） | **866 秒** | **902 秒** |
| スタック完了から ALB が初めて HTTP 200 を返すまで | 約 80 秒 | 約 50 秒 |

ホスト名は Ingress を適用した数秒後に取れます。ただしその時点の ALB はまだ `provisioning` で、最初の 200 が返るのは 1〜2 分後です。

### 2. クラスター内で動いているもの

| | Managed Node Group | Auto Mode |
| --- | --- | --- |
| スタック完了直後のノード | `t3.medium` × 2（1a、1d）、AL2023 | `c5a.large` / `c5a.large` / `c6a.large` の **3 台**（1a、1c、1d）、Bottlerocket |
| ワークロードがないときのノード | 2 台（ノードグループの最小数） | 0 台（アプリを適用する前） |
| `kube-system` の Pod | VPC CNI、kube-proxy、CoreDNS、Pod Identity エージェント、コントローラー × 2 | なし（アプリ適用前の `kubectl get pods -A` は空） |
| `aws eks list-addons` | `eks-pod-identity-agent` | （空） |
| Pod の配置 | 1a：1、1d：2 | 1a：1、1c：1、1d：1 |

同じ Deployment でも、ノード数が変わりました。

- **Managed Node Group:** トポロジー分散は、すでにノードがある AZ だけを数えます。ノードグループが 2 台を 1a と 1d に置いたので、分散は 1 対 2 になり、3 つ目の AZ は使われませんでした。
- **Auto Mode:** Pending の Pod に合わせてノードを用意します。AZ をまたぐ `DoNotSchedule` の指定により、100m の Pod 3 つのために **AZ ごとに 1 台ずつノードを起動** しました。

ノード数を厳密な分散より優先したい場合は、`ScheduleAnyway` にするか、レプリカ数を AZ 数より少なくしてください。

コントローラー Pod の環境変数を見ると、IRSA ではなく Pod Identity で認証していることが分かります。

- 注入されていた変数：`AWS_CONTAINER_CREDENTIALS_FULL_URI=http://169.254.170.23/v1/credentials`、`AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE=/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token`
- IRSA の変数（`AWS_ROLE_ARN` / `AWS_WEB_IDENTITY_TOKEN_FILE`）はありません。

Pod の `ZONE` 変数は、Downward API で `metadata.labels['topology.kubernetes.io/zone']` から読んでいます。両クラスターとも値が入っていました。Kubernetes 1.36 では、ノードのトポロジーラベルが Pod にコピーされるためです。

### 3. 2 つのコントローラーが作る ALB

| | Managed Node Group | Auto Mode |
| --- | --- | --- |
| 名前 | `k8s-web-web-<hash>` | `k8s-web-web-<hash>` |
| フロントエンド SG | `k8s-web-web-<hash>`：ポート 80 をクライアントの `/32` からのみ許可 | 同じ |
| バックエンド SG | `k8s-traffic-<cluster>-<hash>`（クラスター内の全 ALB で共有） | 同じ命名 |
| ターゲットタイプ / ヘルスチェック / 登録解除の遅延 | `ip`、`/health`、15 秒 | `ip`、`/health`、15 秒 |
| ALB に付くタグ | `elbv2.k8s.aws/cluster`、`ingress.k8s.aws/stack`、`ingress.k8s.aws/resource` | `eks:eks-cluster-name`、`ingress.eks.amazonaws.com/stack`、`ingress.eks.amazonaws.com/resource` |

できあがる ALB は同じです。違うのは設定をどこから読むかと、所有者を示すタグです。タグの違いは、ALB を一方のコントローラーからもう一方へ移すときに問題になります。

### 4. トラフィック中のローリング再起動

各 ALB に毎秒約 6 リクエストを流しながら、両クラスターで `kubectl rollout restart deploy/web` を実行しました。

| | リクエスト数 | 200 以外 | `rollout status` |
| --- | --- | --- | --- |
| Managed Node Group | 892 | 0 | 17.7 秒 |
| Auto Mode | 858 | 0 | 5.4 秒 |

Pod Readiness Gate がなくても、次の 3 つでエラーは出ませんでした。

- Readiness Probe
- SIGTERM 後に 10 秒間リクエストを処理し続ける動作（その間 `/health` は 503 を返す）
- 15 秒の登録解除遅延

### 5. 30 レプリカへのスケールアウト

| | 5 分後 |
| --- | --- |
| Managed Node Group | Running 23、**Pending 7 のまま**。理由は `1 Too many pods, 1 node(s) didn't match pod topology spread constraints`。`t3.medium` はノードあたり 17 Pod が上限です。`maxSize` は 4 ですが、ノードは 2 台のままでした（Cluster Autoscaler も Karpenter も入れていないため）。 |
| Auto Mode | 既存の 3 台で、15 秒以内に 30 Pod すべてが Running（新しいノードは不要でした）。 |

Managed Node Group の `maxSize` は、ノード数を増減させる仕組みがあって初めて意味を持つ上限です。ノードグループ方式では、その仕組み（Cluster Autoscaler か Karpenter、シリーズ L-3）を入れることが次の運用課題になります。

### 6. 1 レプリカへのスケールイン

Auto Mode の `general-purpose` NodePool は、`consolidationPolicy: WhenEmptyOrUnderutilized`、`consolidateAfter: 30s`、予算 `10%` で設定されています。

- 1 レプリカに減らすと、空になった 2 台のノードを **+65 秒と +91 秒** に 1 台ずつ終了しました（`Disrupting NodeClaim: Empty`）。
- +130 秒以降は 1 台で動いていました。
- Managed Node Group は 2 台のままでした。

### 7. 削除

`cdk destroy '**'` はスタックを 1 つずつ削除し、全体で 49.5 分かかりました。内訳は Managed Node Group 23 分、Auto Mode 25 分、ネットワーク 1.3 分です。

- **削除の順序:** 両クラスターとも、まず Ingress が削除され（35 秒。コントローラーが ALB と `k8s-*` セキュリティグループを削除）、その後にコントローラーのチャートが削除されました。
- **時間がかかった箇所:** ノードグループ（8.5 分）と、**VPC 内の kubectl ハンドラー Lambda（スタックによって 10 分と 19 分）** です。Lambda はネットワークインターフェイスの解放を待っていました。
- **削除後の確認:** スタック、クラスター、`k8s-*` の ALB、EC2 インスタンス、`/aws/eks/...` のロググループ、VPC のどれも残っていませんでした。

### 8. デプロイ中に見つかった落とし穴

- **IAM Identity Center のロールを使ったアクセスエントリ:**
  - パスを除いたロール ARN（`arn:aws:iam::<acct>:role/AWSReservedSSO_...`）を指定すると、`The specified principalArn is invalid: invalid principal` で拒否されます。
  - クラスターができた後でスタック全体がロールバックするので、クラスター 1 つにつき約 9 分を失います。
  - `aws iam get-role` が返す、`aws-reserved/sso.amazonaws.com/<region>/` を含む ARN を指定してください。パスを除くのは、旧来の `aws-auth` ConfigMap を使う場合のルールです。
- **Stage に対する cdk-nag:**
  - `Aspects.of(app).add(new AwsSolutionsChecks())` は、`cdk.Stage` 配下のスタックには届きません。コンプライアンステストは、1 件も検査しないまま成功していました。
  - テストではパックを Stage に付け、抑制した指摘が実際に記録されたことも確認しています。

## 🏛️ Well-Architected との対応

| 柱 | Managed Node Group | Auto Mode |
| --- | --- | --- |
| 運用上の優秀性 | AMI のパッチ、ノードグループ・VPC CNI・kube-proxy・CoreDNS・コントローラーの更新は自分で行う | ノードのパッチ（Bottlerocket）、ネットワーク・DNS・ロードバランシングは EKS が行う。両クラスターとも全種類のコントロールプレーンログを保持期間付きで記録 |
| セキュリティ | Pod Identity を 1 つのサービスアカウントに限定。ノードはプライベート。ALB と API エンドポイントはクライアントに限定。Secret は KMS で暗号化 | 同じ。加えて、更新し続けるべきクラスター内のコンポーネントが少ない |
| 信頼性 | 3 AZ を使えるが、ノードグループのノードは 2 AZ に置かれた。ノードの自動スケーリングはない | AZ 分散のために AZ ごとに 1 台。ノードの置き換えと集約は自動 |
| パフォーマンス効率 | インスタンスタイプは固定。ノードあたりの Pod 上限あり（`t3.medium` は 17） | Pod のリクエストに合わせてインスタンスタイプを選ぶ |
| コスト最適化 | 管理料金はない。ノードグループの余剰キャパシティにも費用がかかる | インスタンスごとに管理料金（EC2 価格の約 12%）。空いたノードは約 1〜2 分で削除 |
| 持続可能性 | 余剰キャパシティが動き続ける | キャパシティがワークロードに追従する |

## 💰 コスト

ap-northeast-1、月 730 時間、Pricing API のオンデマンド定価（2026-10-29 時点）で計算しています。

- EKS クラスター：$0.10/時
- `t3.medium`：$0.0544/時
- `c5a.large`：$0.096/時 + Auto Mode 管理料金 $0.01152/時
- `c6a.large`：$0.0963/時 + $0.01156/時

| 項目 | Managed Node Group | Auto Mode（実測どおり 3 台） |
| --- | --- | --- |
| EKS コントロールプレーン | 73.0 | 73.0 |
| EC2 | 2 × 0.0544 × 730 = 79.4 | (0.096 × 2 + 0.0963) × 730 = 210.5 |
| Auto Mode 管理料金 | — | (0.01152 × 2 + 0.01156) × 730 = 25.3 |
| ALB（$0.0243/時 + 約 1 LCU） | 約 24 | 約 24 |
| EBS、CloudWatch Logs、KMS | 約 6 | 約 6 |
| **クラスターあたり（USD/月）** | **約 182** | **約 339** |

両クラスターで共有する費用は、NAT ゲートウェイ約 45、パブリック IPv4（NAT + ALB 2 つ × 3 AZ）約 26 です。**dev で両クラスターを動かすと月約 590 USD（時間あたり約 0.81 USD）** になります。使い終わったら削除してください。

Auto Mode の金額は、Auto Mode そのものではなく、`large` インスタンスで厳密な AZ 分散を取ったことの費用です。

- 1 レプリカのときは 1 台で動きました（EC2 と管理料金で月約 78 USD）。
- 管理料金は、インスタンス価格に一律約 12% が上乗せされます。

ここで Managed Node Group の方が安いのは、小さい 2 台で足り、ノード数を増やす仕組みもなかったからです。7 Pod が Pending のままだったのも同じ理由です。

本番環境では次を検討してください。

- AZ ごとの NAT ゲートウェイ、または VPC エンドポイント
- ノードグループ側は 3 台以上にするか、Karpenter を導入する
- ALB の HTTPS 化

## 🔒 セキュリティ

- **API エンドポイント:** パブリックアクセスは `ALLOWED_IPS`（`/32`）に限定し、プライベートアクセスを有効にしています。kubectl ハンドラーはプライベートサブネットで動きます。
- **クラスターへのアクセス:** 認証モードは API（アクセスエントリ）です。cluster-admin は `EKS_ADMIN_PRINCIPAL_ARN` と kubectl ハンドラーのロールにだけ付与しています。
- **コントローラーの IAM:**
  - Pod Identity でロールを `kube-system/aws-load-balancer-controller` だけに結び付けています。
  - アップストリームのポリシーは、変更系の Elastic Load Balancing / EC2 アクションを `elbv2.k8s.aws/cluster` タグの条件で絞っています。
  - Auto Mode は、代わりにクラスターロールの `AmazonEKSLoadBalancingPolicy` を使います。
- **Ingress:** ALB のセキュリティグループは、ポート 80 を `ALLOWED_IPS` からだけ許可します（アノテーション `inbound-cidrs` / `IngressClassParams.inboundCIDRs`）。本番では HTTPS（ACM）と AWS WAF を追加してください。
- **Pod:** 非 root、読み取り専用のルートファイルシステム、全ケーパビリティを削除、`RuntimeDefault` seccomp。ノードはプライベートサブネットに置いています。
- **データ:** Kubernetes Secret はローテーションする KMS キーで暗号化しています。コントロールプレーンログ（監査ログを含む）は dev では 7 日間保持します。

CDK Nag（`test/compliance/cdk-nag.test.ts`、パックは Stage に付与）で抑制しているのは次の 3 つです。ネットワークスタックには指摘はありません。

- **IAM4:** クラスターロールとノードロールに EKS が必要とするマネージドポリシー、kubectl ハンドラーの Lambda 用マネージドポリシー
- **IAM5:** アップストリームのコントローラーポリシー、Provider Framework がハンドラーの各バージョンを呼び出す権限
- **L1:** kubectl ハンドラーのランタイム（aws-cdk-lib が決めている）

## 📋 前提条件

- Node.js 24、AWS CDK CLI、ブートストラップ済みのアカウント
- 以下の確認には AWS CLI v2 と `kubectl` 1.36

## 🚀 デプロイ

```bash
cd infrastructure/workspaces/eks-managed-node-group-vs-auto-mode

# Client IPs allowed on the ALBs and the public API endpoint (defaults to this machine's global IP)
export ALLOWED_IPS=203.0.113.10
# IAM role that gets cluster-admin: the full ARN, including the aws-reserved/... path for SSO roles
export EKS_ADMIN_PRINCIPAL_ARN=$(aws iam get-role --role-name <role-name> --query Role.Arn --output text)

PROJECT=myproject ENV=dev npm run stage:deploy:all -- --require-approval never --concurrency 2
```

ネットワークスタックの後、2 つのクラスタースタックが並行してデプロイされます（約 15 分）。完了したら次のように確認します。

```bash
for c in mng auto; do
  aws eks update-kubeconfig --name myproject-dev-eks-$c --alias $c
done
kubectl --context auto get nodes -L topology.kubernetes.io/zone,node.kubernetes.io/instance-type,karpenter.sh/nodepool
kubectl --context mng -n kube-system get deploy aws-load-balancer-controller

curl -s "$(aws cloudformation describe-stacks --stack-name myproject-dev-eks-mng \
  --query "Stacks[0].Outputs[?OutputKey=='AlbUrl'].OutputValue" --output text)"
# {"cluster": "managed-node-group", "pod": "web-...", "node": "ip-10-96-...", "az": "ap-northeast-1a", ...}
```

## 🧪 テスト戦略

```bash
npm test                 # all
npm run test:unit        # 34 unit tests
npm run test:snapshot    # template + resource counts per stack
npm run test:compliance  # cdk-nag on the Stage
```

- **Unit（`test/unit/stage.test.ts`）:**
  - 共通：スタックの有効・無効の切り替え、サブネットのロールタグ
  - 両クラスター共通の設定：バージョン、エンドポイントの CIDR、KMS、ログと事前作成したロググループへの依存、アクセスエントリ、VPC 内の kubectl ハンドラー、Deployment と Ingress のマニフェストの中身
  - Managed Node Group：明示的なノードグループ、`ComputeConfig` が無効、Pod Identity の信頼ポリシーと OIDC プロバイダーがないこと、ノードグループ後のエージェントアドオン、Helm の values、ポリシーのステートメント数がアップストリームと一致すること、ワークロードがチャートに依存すること
  - Auto Mode：コンピューティング・ストレージ・ロードバランシングの同時有効化、ノードグループ / Helm / 関連付け / アドオンがないこと、IngressClassParams の形
- **スナップショット:** スタックごと。アセットのハッシュはマスクしています。
- **コンプライアンス:** AwsSolutions パックを Stage に付けて検査し、実際に検査が行われたことも確認します。

## ⚙️ カスタマイズ

| パラメータ | 効果 |
| --- | --- |
| `managedNodeGroup.enabled` / `autoMode.enabled` | 片方のクラスターだけをデプロイする |
| `kubernetesVersion` | `cluster-defaults.ts` の `KubectlV36Layer` とそろえる |
| `managedNodeGroup.nodeGroup` | インスタンスタイプ、最小 / 希望 / 最大、ディスクサイズ |
| `managedNodeGroup.albControllerChartVersion` | `src/alb-controller-iam-policy-v<version>.json` も追加する |
| `autoMode.nodePools` | `system`、`general-purpose`、または `[]`（NodePool を自分で用意する） |
| `webApp.replicas` / リクエスト量 | Auto Mode のノード数が変わる（検証結果 2 を参照） |
| `network` | CIDR、AZ 数、NAT ゲートウェイ数 |

## 🔧 トラブルシューティング

| 症状 | 原因 / 対処 |
| --- | --- |
| `AWS::EKS::AccessEntry` が `The specified principalArn is invalid: invalid principal` で失敗する | ロール ARN からパスが除かれている。`aws iam get-role` が返す ARN を指定する（検証結果 8） |
| `kubectl` で `the server has asked for the client to provide credentials` と表示される | 自分のプリンシパルにアクセスエントリがない。`EKS_ADMIN_PRINCIPAL_ARN` を設定して再デプロイする |
| `cdk destroy` が `KubectlProviderHandler` で 10〜20 分止まる | VPC 内の Lambda がネットワークインターフェイスの解放を待っている。待てば完了する（検証結果 7） |
| `kubectl` がタイムアウトする | 自分の IP が `ALLOWED_IPS`（パブリックエンドポイントの CIDR）に入っていない |
| Service や Ingress の適用が `failed calling webhook` エラーで失敗する | コントローラーのアドミッション Webhook がまだ準備できていない。`webApp.node.addDependency(albController)` とチャートの `wait: true` を外さない |
| ノードグループ側で Pod が `Too many pods` により `Pending` になる | インスタンスタイプごとの Pod 上限（`t3.medium` は 17）。大きいインスタンスにする、ノードを増やす、またはノードのオートスケーラーを入れる |
| Auto Mode のノードが想定より多い | `DoNotSchedule` の AZ 分散は AZ ごとに 1 台を必要とする。`kubectl get nodeclaims` で確認する |
| Ingress にアドレスが付かない | コントローラーのログ（`kubectl -n kube-system logs deploy/aws-load-balancer-controller`）、Auto Mode なら `kubectl describe ingress` を確認する。サブネットのタグも確認する |
| `cdk destroy` 後に ALB や `k8s-*` セキュリティグループが残り、VPC を削除できない | Ingress より先にコントローラーが削除された。ALB と `k8s-*` グループを削除してから、もう一度削除を実行する |

## 🧹 クリーンアップ

```bash
PROJECT=myproject ENV=dev npm run stage:destroy:all
```

クラスターのスタックは、まず Ingress を削除します（ALB とその `k8s-*` セキュリティグループはコントローラーが削除します）。その後クラスターを削除し、最後にネットワークスタックを削除します。両クラスターで約 50 分かかります（検証結果 7）。

## 📚 参考資料

- [aws-eks-v2 モジュール（AWS CDK）](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_eks_v2-readme.html)
- [Create an IngressClass to configure an Application Load Balancer（EKS Auto Mode）](https://docs.aws.amazon.com/eks/latest/userguide/auto-configure-alb.html)
- [Route internet traffic with AWS Load Balancer Controller](https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html)
- [Learn how EKS Pod Identity grants pods access to AWS services](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)
- [Grant IAM users access to Kubernetes with EKS access entries](https://docs.aws.amazon.com/eks/latest/userguide/access-entries.html)
- [Amazon EKS の料金](https://aws.amazon.com/eks/pricing/)
- ナレッジベース：[docs/knowledge/eks-managed-node-group-vs-auto-mode.md](../../../docs/knowledge/eks-managed-node-group-vs-auto-mode.md)

---

**Level 300** · [AWS CDK Reference Architectures](../../../README.md) の一部
