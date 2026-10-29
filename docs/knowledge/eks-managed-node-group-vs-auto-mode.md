# EKS Managed Node Group vs Auto Mode with aws-eks-v2 — Measured Behavior

Two EKS 1.36 clusters (managed node group + AWS Load Balancer Controller on Pod Identity, and EKS
Auto Mode) serving the same Deployment through an Ingress-created ALB were deploy-verified in
[`eks-managed-node-group-vs-auto-mode`](../../infrastructure/workspaces/eks-managed-node-group-vs-auto-mode/)
on 2026-10-29 (ap-northeast-1, aws-cdk-lib 2.273.0, `@aws-cdk/lambda-layer-kubectl-v36` 2.0.1,
controller chart 3.2.2). Single runs.

Sources:
[aws-eks-v2](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_eks_v2-readme.html) /
[Auto Mode IngressClass](https://docs.aws.amazon.com/eks/latest/userguide/auto-configure-alb.html) /
[Access entries](https://docs.aws.amazon.com/eks/latest/userguide/access-entries.html) /
[Configure an SSO user (re:Post)](https://repost.aws/knowledge-center/eks-configure-sso-user)

## Access entries need the full IAM Identity Center role ARN (with path)

- `AWS::EKS::AccessEntry` with `arn:aws:iam::<acct>:role/AWSReservedSSO_<name>` (path removed)
  fails: `The specified principalArn is invalid: invalid principal. (Service: Eks, Status Code: 400)`.
- The same role as returned by `aws iam get-role`
  (`arn:aws:iam::<acct>:role/aws-reserved/sso.amazonaws.com/<region>/AWSReservedSSO_<name>`)
  works, and `kubectl` from that SSO session is authorized.
- Removing the path is the documented rule for the **legacy `aws-auth` ConfigMap** only; it is easy
  to carry over by habit. The failure comes after `AWS::EKS::Cluster` is created (~9–10 min), and
  the rollback deletes the cluster again (measured 3.5 min for Auto Mode, 13 min for the node group cluster) — 13–23 minutes lost per attempt.

## cdk-nag aspects on the App do not reach stacks in a Stage

- `cdk.Aspects.of(app).add(new AwsSolutionsChecks())` + `Annotations.fromStack(stageStack)` found
  zero findings for stacks created inside a `cdk.Stage`; with the aspect on the stage
  (`Aspects.of(stage)`) the same stacks reported IAM4/IAM5/L1 findings. A compliance test written
  the App way passes vacuously.
- Guard: attach the pack to the Stage, enable `logIgnores: true`, and assert that at least one
  suppressed finding was logged (`findInfo('*', /AwsSolutions-.../)`).
- Workspaces whose tests build a Stage and add the aspect to the App should be re-checked
  (found: `multi-region-dr-strategies`).

## aws-eks-v2 construct facts

- Default capacity type is **Auto Mode**; `defaultCapacityType: NODEGROUP` is required for a node
  group cluster. With `NODEGROUP`, the template still contains `ComputeConfig: { Enabled: false }`.
- Auto Mode enables compute, block storage and ELB together (`ComputeConfig`, `StorageConfig`,
  `KubernetesNetworkConfig.ElasticLoadBalancing`) and attaches `AmazonEKSClusterPolicy`,
  `AmazonEKSComputePolicy`, `AmazonEKSBlockStoragePolicy`, `AmazonEKSLoadBalancingPolicy`,
  `AmazonEKSNetworkingPolicy` to the cluster role; the node pool role gets
  `AmazonEKSWorkerNodePolicy` + `AmazonEC2ContainerRegistryReadOnly` (no CNI policy).
- The kubectl handler is created only with `kubectlProviderOptions` and, with private endpoint
  access, runs in the private subnets (VPC config set automatically). The handler role also gets an
  access entry, so a cluster with one admin principal has 2 access entries.
- `cluster.addManifest()` / `addHelmChart()` / `addServiceAccount()` create the resource **under the
  cluster** (`Cluster/manifest-<id>`); `myConstruct.node.addDependency(x)` does not reach it. Create
  `KubernetesManifest` / `HelmChart` / `ServiceAccount` with your construct as scope.
- `ServiceAccount` with `identityType: POD_IDENTITY` creates a role trusted by
  `pods.eks.amazonaws.com` (`sts:AssumeRole` + `sts:TagSession`), an
  `AWS::EKS::PodIdentityAssociation`, and lazily the `eks-pod-identity-agent` add-on
  (`cluster.eksPodIdentityAgent`); no OIDC provider. Making the add-on and the association depend on
  the node group worked (add-on ACTIVE 24 s after the node group).
- The built-in `albController` option always uses IRSA. The upstream policy files ship in
  `aws-cdk-lib/aws-eks-v2/lib/addons/alb-iam_policy-v<version>.json` (v3.2.2 is the newest in 2.273).
- Without `image.repository`, the chart pulls `public.ecr.aws/eks/aws-load-balancer-controller:v<version>`.

## Timings (ap-northeast-1)

| Step | Managed node group | Auto Mode |
| --- | --- | --- |
| `AWS::EKS::Cluster` create | 9 min 05 s | 10 min 06 s |
| Node group (2 × t3.medium) | 1 min 20 s | — |
| First manifest applied | 2 min 20 s after the node group | 3 min 40 s after the cluster |
| Controller chart with `wait: true` | 28 s | — |
| Workload + Ingress + `KubernetesObjectValue` hostname | 21 s | 22 s |
| Whole stack | 866 s | 902 s |
| First HTTP 200 after stack complete | ~80 s | ~50 s |
| Rollback of a failed stack after the cluster existed | ~13 min | ~3.5 min |

Teardown (`cdk destroy '**'`, stacks run one after another): 49.5 min in total — node group stack
23 min, Auto Mode stack 25 min, network 1.3 min. The Ingress was deleted first (35 s, ALB and
`k8s-*` SGs removed by the controller) and the chart after it. The long waits: node group delete
8.5 min, and the **VPC-attached kubectl handler Lambda (`KubectlProviderHandler`) 10 min / 19 min**
while its network interfaces were released. Nothing was left behind (stacks, clusters, `k8s-*`
ALBs/SGs, instances, `/aws/eks/...` log groups, VPC).

The Ingress hostname is in `.status` seconds after the Ingress is applied, while the ALB is still
`provisioning`.

## Runtime behavior

- **Auto Mode with no workload has 0 nodes** and `kubectl get pods -A` is empty (CoreDNS, CNI,
  kube-proxy, LB controller run off-cluster). `aws eks list-addons` is empty.
- The node group cluster lists only `eks-pod-identity-agent` as an add-on; VPC CNI, kube-proxy and
  CoreDNS are self-managed bootstrap copies (`bootstrapSelfManagedAddons` default).
- **Strict zone spread drives Auto Mode's node count**: 3 replicas × 100m CPU with
  `topologySpreadConstraints` on zone + `DoNotSchedule` → 3 nodes (c5a.large ×2, c6a.large, one per
  AZ). The node group with 2 nodes in 1a/1d placed 1/2 (spread counts only zones with nodes).
- Scale to 30 replicas: node group → 7 Pending (`Too many pods`; t3.medium = 17 pods/node, nothing
  scales the group despite `maxSize: 4`); Auto Mode → 30 Running on the same 3 nodes in < 15 s.
- Scale to 1 replica: Auto Mode `general-purpose` NodePool (`WhenEmptyOrUnderutilized`,
  `consolidateAfter: 30s`, budget `10%`) terminated the 2 empty nodes at +65 s and +91 s
  (`Disrupting NodeClaim: Empty`, one at a time).
- Kubernetes 1.36 copies node topology labels onto pods: a Downward API env from
  `metadata.labels['topology.kubernetes.io/zone']` was filled on both node types.
- Nodes: managed node group AL2023 (containerd 2.3.7); Auto Mode Bottlerocket "EKS Auto, Standard"
  (containerd 2.2.9).
- Rolling restart with readiness probe + 10 s drain + 15 s deregistration: 0 non-200 in 892 / 858
  requests (no pod readiness gates).

## ALBs created by the two controllers

- Same shape: `k8s-<ns>-<ingress>-<hash>` ALB, frontend SG with the `inbound-cidrs` /
  `inboundCIDRs` only, shared backend SG `k8s-traffic-<cluster>-<hash>`, IP targets.
- Ownership tags differ: OSS controller `elbv2.k8s.aws/cluster`, `ingress.k8s.aws/stack`,
  `ingress.k8s.aws/resource`; Auto Mode `eks:eks-cluster-name`, `ingress.eks.amazonaws.com/stack`,
  `ingress.eks.amazonaws.com/resource`.
- Auto Mode: settings that apply to the class go in `IngressClassParams` (`eks.amazonaws.com/v1`,
  fields `scheme`, `targetType`, `inboundCIDRs`); `healthcheck-path` and
  `target-group-attributes` annotations on the Ingress are honored (target group had `/health`,
  deregistration 15 s).

## Pricing (ap-northeast-1, Pricing API 2026-10-29)

- EKS cluster $0.10/h (`APN1-AmazonEKS-Hours:perCluster`).
- Auto Mode management fee per instance-hour, usage type `APN1-EKS-Auto:<type>-management-hours`:
  c5a.large $0.01152 (EC2 $0.096), c6a.large $0.01156 (EC2 $0.0963) — 12% of the EC2 price.
- t3.medium $0.0544/h.
