# CodeBuild Buildspec ガイド

このディレクトリには、AWS CodeBuildでDockerイメージをビルドするための2つのbuildspecファイルが含まれています。

## ファイル

### 1. buildspec.yml (基本版)

シンプルなDockerイメージビルドとECRプッシュ用の設定です。

**特徴:**
- Dockerイメージのビルド
- ECRへのログインとプッシュ
- コミットハッシュとlatestタグの両方でタグ付け
- ECSデプロイ用のimagedefinitions.json生成

### 2. buildspec-with-tests.yml (完全版)

テストとセキュリティスキャンを含む完全な設定です。

**特徴:**
- Node.js依存関係のインストール
- ユニットテストの実行
- Trivyによるコンテナセキュリティスキャン
- ビルドメタデータの埋め込み
- テストレポートの生成

## 環境変数

CodeBuildプロジェクトで以下の環境変数を設定してください：

| 変数名 | 説明 | 例 |
|--------|------|-----|
| `AWS_ACCOUNT_ID` | AWSアカウントID | `123456789012` |
| `AWS_DEFAULT_REGION` | AWSリージョン | `ap-northeast-1` |
| `ECR_REPOSITORY_NAME` | ECRリポジトリ名 | `example-nodejs-api` |
| `IMAGE_TAG` | イメージタグ（オプション） | `latest` / `v1.0.0` |

## 必要なIAMポリシー

CodeBuildのサービスロールに以下の権限が必要です：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::your-artifact-bucket/*"
    }
  ]
}
```

## CodeBuildプロジェクトの設定

### コンソールでの設定

1. **プロジェクト名**: `example-nodejs-api-build`
2. **ソース**: GitHub / CodeCommit
3. **環境**:
   - イメージ: `aws/codebuild/standard:7.0`
   - 環境タイプ: `Linux`
   - 特権モード: `有効` (Dockerビルドに必要)
4. **Buildspec**: `buildspec.yml`
5. **アーティファクト**: S3バケット (オプション)

### CDKでの設定例

```typescript
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';

// ECRリポジトリ
const repository = new ecr.Repository(this, 'Repository', {
  repositoryName: 'example-nodejs-api',
  imageScanOnPush: true,
});

// CodeBuildプロジェクト
const project = new codebuild.Project(this, 'BuildProject', {
  projectName: 'example-nodejs-api-build',
  source: codebuild.Source.gitHub({
    owner: 'your-github-user',
    repo: 'your-repo',
    webhook: true,
    webhookFilters: [
      codebuild.FilterGroup.inEventOf(
        codebuild.EventAction.PUSH
      ).andBranchIs('main'),
    ],
  }),
  environment: {
    buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
    privileged: true, // Docker build requires privileged mode
  },
  environmentVariables: {
    AWS_ACCOUNT_ID: {
      value: this.account,
    },
    AWS_DEFAULT_REGION: {
      value: this.region,
    },
    ECR_REPOSITORY_NAME: {
      value: repository.repositoryName,
    },
    IMAGE_TAG: {
      value: 'latest',
    },
  },
  buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
  cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER),
});

// ECRへのプッシュ権限を付与
repository.grantPullPush(project);
```

## ローカルでのテスト

CodeBuild Localを使用してローカルでテストできます：

```bash
# CodeBuild Local Agentのダウンロード
git clone https://github.com/aws/aws-codebuild-docker-images.git
cd aws-codebuild-docker-images/local_builds

# ビルドの実行
./codebuild_build.sh \
  -i aws/codebuild/standard:7.0 \
  -a /path/to/artifact/output \
  -s /path/to/source \
  -e /path/to/envvars.txt
```

## トラブルシューティング

### エラー: "denied: User not authenticated"

**原因**: ECRへの認証が失敗しています。

**解決策**:
- CodeBuildのサービスロールにECR権限があるか確認
- 環境変数が正しく設定されているか確認

### エラー: "Cannot connect to the Docker daemon"

**原因**: Dockerデーモンに接続できません。

**解決策**:
- CodeBuildプロジェクトで「特権モード」を有効にする

### ビルドが遅い

**解決策**:
- キャッシュを有効化（Docker Layer Cache）
- マルチステージビルドを最適化
- 不要なファイルを.dockerignoreに追加

## CI/CDパイプライン統合

CodePipelineと統合する例：

```typescript
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';

const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
  pipelineName: 'example-nodejs-api-pipeline',
});

// Source stage
const sourceOutput = new codepipeline.Artifact();
pipeline.addStage({
  stageName: 'Source',
  actions: [
    new codepipeline_actions.GitHubSourceAction({
      actionName: 'GitHub_Source',
      owner: 'your-github-user',
      repo: 'your-repo',
      oauthToken: SecretValue.secretsManager('github-token'),
      output: sourceOutput,
      branch: 'main',
    }),
  ],
});

// Build stage
const buildOutput = new codepipeline.Artifact();
pipeline.addStage({
  stageName: 'Build',
  actions: [
    new codepipeline_actions.CodeBuildAction({
      actionName: 'Docker_Build',
      project: project,
      input: sourceOutput,
      outputs: [buildOutput],
    }),
  ],
});

// Deploy stage
pipeline.addStage({
  stageName: 'Deploy',
  actions: [
    new codepipeline_actions.EcsDeployAction({
      actionName: 'ECS_Deploy',
      service: ecsService,
      input: buildOutput,
    }),
  ],
});
```

## 参考リンク

- [AWS CodeBuild Documentation](https://docs.aws.amazon.com/codebuild/)
- [Buildspec Reference](https://docs.aws.amazon.com/codebuild/latest/userguide/build-spec-ref.html)
- [Docker in CodeBuild](https://docs.aws.amazon.com/codebuild/latest/userguide/sample-docker.html)
