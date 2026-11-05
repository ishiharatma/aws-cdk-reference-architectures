# code-server Session Control Plane — Cognito のログイン1つで、ユーザーごとの code-server を MicroVM または EC2 に起動する

*他の言語で読む(Read this in other languages):* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## はじめに

[code-server](https://github.com/coder/code-server)(ブラウザで動く VS Code)を、ユーザーごとにオンデマンドで起動するリファレンス実装です。Amazon Cognito で認証するコントロールプレーンが、[AWS Lambda MicroVM](https://aws.amazon.com/lambda/lambda-microvms/) または EC2 インスタンスを1ユーザー1台で起動します。

[`lambda-microvms-codex-appserver`](../lambda-microvms-codex-appserver/README.ja.md) のコントロールプレーンの考え方を code-server に適用したもので、[`code-server-ec2-vs-lambda-microvms`](../code-server-ec2-vs-lambda-microvms/README.ja.md) で必要だった AWS 認証情報を、利用者の手元から取り除きました。code-server の公式 FAQ と [導入解説記事](https://www.issoh.co.jp/tech/details/18117/)が勧める「1ユーザー1VM」「共有パスワードの代わりに認証基盤で個人を識別」「EC2 は受信ポートを全閉にして Session Manager で接続」を、そのまま構成に反映しています。

このアーキテクチャで確認できること:

- ブラウザからカスタムヘッダーを送れない MicroVM エンドポイントへ届ける2つの方法。ローカルリレー(方式 A)と、CloudFront + Lambda@Edge(方式 B)
- HttpOnly Cookie のトークンを Lambda@Edge で `X-aws-proxy-auth` ヘッダーとオリジンに変換し、状態もシークレットも持たずにセッション単位でルーティングする方法
- AWS 認証情報を持たないユーザーへ、コントロールプレーンが開いた Session Manager のポートフォワードを渡す方法
- 利用者がターミナルを持つ環境で、実行ロールとシークレットをどう設計するか
- 指定した複数の CodeCommit リポジトリへ、ロールの権限で `git clone` と `git push` する方法
- インターネットへの経路をなくした閉域構成。外部サイト、他アカウントの AWS リソース、DNS 経由の送信を塞ぎ、CodeCommit、Bedrock、npm、pip は使える
- 共通ロールのまま他人の分を読めない、ワークスペースの保存と復元
- MFA、利用者の即時停止、アラーム、監査ログ
- 検証環境の費用を抑える NAT インスタンスと、NAT Gateway のパラメータでの切り替え
- 2026-11-05 に実機でエンドツーエンドの検証を実施。実ブラウザでのログインと IDE の表示を含む。見つかって直した不具合は[実機デプロイ検証](#-実機デプロイ検証)にまとめている

## 📑 目次

- [アーキテクチャ概要](#️-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [コスト最適化](#-コスト最適化)
- [セキュリティ考慮事項](#-セキュリティ考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [使い方](#使い方)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#️-カスタマイズ)
- [実機デプロイ検証](#-実機デプロイ検証)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![Architecture Overview](overview.drawio.svg)

3つの接続経路があり、どれも同じコントロールプレーンの背後にあります。

| | 方式 A: ローカルリレー | 方式 B: ブラウザのみ | EC2 版 |
| --- | --- | --- | --- |
| コンピュート | MicroVM | MicroVM | プライベートサブネットの EC2 |
| 利用者の手元に必要なもの | Node.js | ブラウザ | Node.js と `session-manager-plugin` |
| 開く URL | `http://localhost:8443` | `https://<ディストリビューション>/__cp/portal` | `http://localhost:8443` |
| トークンの持ち方 | リレーのプロセス内 | HttpOnly Cookie | Session Manager のストリームトークン |
| IDE の通信経路 | 手元 → MicroVM エンドポイント | CloudFront → Lambda@Edge → MicroVM エンドポイント | 手元 → Session Manager → インスタンス |
| アイドル時 | 15分で自動サスペンド | 15分で自動サスペンド | 自動では止まらない。起動から8時間で停止 |
| 起動時間(実測) | 7〜21秒 | 7〜21秒 | 約100秒(初回セットアップ) |
| 停止後の状態 | サスペンド中は保持、終了すると消える | 同左 | 停止中も EBS に残る、終了すると消える |

### スタック

| スタック | 内容 | 省略方法 |
| --- | --- | --- |
| `Microvm` | MicroVM イメージ、ビルドロール、実行ロール、ロググループ | 必須 |
| `PrivateNetwork` | 閉域 VPC、VPC エンドポイント、DNS Firewall、CodeArtifact、ネットワークコネクタ | `microvm.egress` を `internet` にする |
| `Ec2` | VPC、NAT Gateway または NAT インスタンス、起動テンプレート、インスタンスロール | `params.ec2` を削除。閉域とは併用できない |
| `CodeCommit` | このアプリが所有するリポジトリ。スタックと一緒に削除される | `managedRepositoryNames` を空にする |
| `ControlPlane` | Cognito、HTTP API、Lambda、DynamoDB、S3(ワークスペース)、アラーム、EC2 のスイープ | 必須 |
| `BrowserAccess` と `edge-lambda-stack-*` | CloudFront、Lambda@Edge(us-east-1)、CloudFront Functions | `browserAccess: false` |

### 主要コンポーネント

| コンポーネント | 役割 |
| --- | --- |
| HTTP API + Cognito JWT Authorizer | すべてのセッション操作を認可する。`GET /portal` だけはデータを持たない静的ページなので認可なし |
| `create-session` | ユーザーごとの上限を実際の状態で確認し、`RunMicrovm` または `RunInstances` を呼ぶ |
| `get-sessions` / `change-session` | 状態の参照、サスペンド、レジューム、終了。どれも所有者のセッションだけを扱う |
| `access-session` | 入口を渡す唯一のルート。リレー用トークン、ブラウザ用 Cookie、EC2 用ストリームトークンを発行する |
| `sweep-ec2` | 15分ごとに実行し、EC2 に MicroVM 相当の上限(稼働時間、セッション期限)を適用する |
| `workspace-url` | セッションのトークンを確認し、その所有者のアーカイブだけに届く署名付き URL を返す |
| `revoke-user` | 運用者が呼ぶ。ユーザーを無効化し、サインアウトさせ、全セッションを終了する |
| `portal` | 方式 B のログイン(MFA の登録とコード入力を含む)とセッション操作の画面 |
| Lambda@Edge `router` | Cookie をオリジンと `X-aws-proxy-auth` に変換する。トークン切れのページ遷移をポータルへ戻す |
| MicroVM 内ランチャー | ライフサイクルフックに応答し、`/run` で code-server を起動し、HTTP と WebSocket をプロキシする |
| `scripts/session.mjs` | Cognito 認証で動くクライアント。リレーとトンネルを含む |
| `scripts/smoke.mjs` | 実際のセッションで経路を検査する運用チェック |

### リクエストの流れ

```text
方式 B(ブラウザのみ)
  ブラウザ ──▶ CloudFront /__cp/* ──▶ HTTP API(ログイン後、Set-Cookie: __Host-mvm=<endpoint>~<JWE>)
  ブラウザ ──▶ CloudFront /*  ──▶ Lambda@Edge (origin-request) ──▶ MicroVM エンドポイント
                                    Cookie → オリジン + X-aws-proxy-auth
                                    X-Forwarded-Host: <ディストリビューション>

方式 A(ローカルリレー)
  session.mjs ──▶ HTTP API: POST /sessions/{id}/access {"type":"relay"} ──▶ { endpoint, token }
  ブラウザ ──▶ localhost:8443 (relay) ──HTTPS + X-aws-proxy-auth──▶ MicroVM エンドポイント

EC2 版
  session.mjs ──▶ HTTP API: POST /sessions/{id}/access {"type":"tunnel"} ──▶ Lambda が ssm:StartSession
  ブラウザ ──▶ localhost:8443 (session-manager-plugin) ──▶ Session Manager ◀── SSM Agent(外向き接続)
                                                                                 └▶ code-server 127.0.0.1:8080
```

## 🎯 設計判断とベストプラクティス

### 1. 利用者がターミナルを持つ前提でロールを設計する

code-server のターミナルからは、実行ロールやインスタンスロールの権限をそのまま使えます。そのためロールは「利用者に渡してよい権限」として設計しました。Bedrock の呼び出しとログの書き込み(EC2 は Session Manager)だけを持ち、DynamoDB やシークレットには触れません。[`lambda-microvms-codex-appserver`](../lambda-microvms-codex-appserver/README.ja.md) の実行ロールが `EventsTable` への書き込みを持つのは利用者がシェルを持たないからで、この違いが設計を分けます。

### 2. 共有パスワードをなくし、`--auth none` にする

code-server のパスワードは1つを全員で共有するので、個人を識別も失効もできません。この構成では、MicroVM はトークンなしのリクエストをプラットフォームが通さず、EC2 は code-server がループバックだけで待ち受けます。どちらもコントロールプレーンを経由しない入口がないので、`--auth none` にして、利用者の識別を Cognito に一本化しました。全セッションで共有するシークレットもなくなります。

### 3. Lambda@Edge は Cookie の形を変えるだけ

Cookie の値は `<エンドポイント>~<JWE>` で、Lambda@Edge はこれをオリジンとヘッダーに移すだけです。DynamoDB を引かず、シークレットも持たず、リクエストごとの遅延も増えません。Cookie を偽造しても、届くのは自分がトークンを持つ MicroVM だけです。任意のホストへの中継を防ぐため、エンドポイントは `*.lambda-microvm.<region>.on.aws` の形式だけを受け付けます。

### 4. code-server のオリジンチェックを残す

`Origin` をエンドポイントに書き換えれば WebSocket は通りますが、code-server の防御を無効にしてしまいます。代わりに、Lambda@Edge とリレーは `X-Forwarded-Host` に閲覧者のホストを渡します。code-server はこれと `Origin` を比較するので、別サイトからの WebSocket は 403 になります。Cookie の `SameSite=Strict` と合わせて二重の防御です。

### 5. `/__cp/*` を同じディストリビューションに置く

Cookie は発行元のドメインに属します。コントロールプレーンを同じドメインの `/__cp/*` で公開すれば、Cookie は CloudFront のドメインに付き、CORS の設定も要りません。GET リクエストの `Authorization` は、キャッシュキーに含めないと CloudFront が転送しません。そのため専用のキャッシュポリシーに入れ、全レスポンスを `no-store` にして、実際には保存されないようにしています。

### 6. EC2 もコントロールプレーンから接続させる

Lambda が `ssm:StartSession` を呼び、ストリーム URL とトークンを所有者に返します。利用者は `session-manager-plugin` を動かすだけで、AWS 認証情報も IAM 権限も要りません。Lambda のポリシーは、タグ付きインスタンスと `AWS-StartPortForwardingSession` ドキュメントに限定しているので、シェルは開けません。

### 7. EC2 にも上限を作る

MicroVM にはアイドルポリシーと最大寿命がありますが、EC2 にはありません。`sweep-ec2` が、起動から `maxRunningHours` を超えたインスタンスを停止し、セッション期限(`ExpiresAt` タグ)を過ぎたものを終了します。アイドルの検知はしないので、使い終わったら自分で停止する必要があります。

### 8. ユーザーごとのセッション数を制限する

サインインしたユーザーは費用のかかるコンピュートを起動できます。`create-session` は `maxActiveSessionsPerOwner`(既定2)を、DynamoDB の記録ではなく実際の状態で確認します。ごく短い間に同時にリクエストすると超える可能性はありますが、費用の暴走を防ぐ用途には十分です。

### 9. CodeCommit はロールの権限で接続し、作成者は Cognito から設定する

Git の認証ヘルパーを `git-codecommit.*.amazonaws.com` に限定して設定するので、ほかの Git ホストの認証には影響しません。権限は `codeCommit` に書いたリポジトリの `GitPull` と `GitPush` だけです。ロールは全セッションで共通なので、**許可したリポジトリには全ユーザーが同じ権限で接続できます**。コミットの作成者には Cognito のメールアドレスが自動で入りますが、利用者は変更できるので、本人確認にはなりません。

### 10. インターネットへの経路をなくす

Network Firewall のドメイン許可も検討しましたが、閉域を既定にしました。許可したドメイン(GitHub や npm など)は持ち出しの経路にもなります。経路自体がなければ、その判断が要りません。費用も、エンドポイント1個あたり月約 $7 で、ファイアウォールの月 $280 以上より抑えられます。

経路をなくすだけでは残る手段を、次のように塞いでいます。

| 持ち出しの手段 | 対策 | 確認結果 |
| --- | --- | --- |
| 外部サイトへの送信 | ルートなし、DNS Firewall | 名前解決できず、IP 直接もタイムアウト |
| 攻撃者自身のアカウントの S3 | S3 ゲートウェイエンドポイントのポリシーで、このアカウントのリソースだけを許可 | `AccessDenied` |
| 攻撃者自身の認証情報 | インターフェイスエンドポイントのポリシーで、このアカウントのプリンシパルだけを許可 | ポリシーで設定 |
| DNS クエリへの埋め込み | DNS Firewall で AWS の名前以外を NXDOMAIN に | 名前解決できない |
| 別リージョン経由 | セキュリティグループで、エンドポイントと同一リージョンの S3 だけを許可 | タイムアウト |
| パッケージの公開 | ミラーは読み取り権限のみ | 公開されなかった |
| ブラウザからのダウンロード | `--disable-file-downloads`、`--disable-file-uploads` | 起動は確認(画面の動作は未確認) |

イメージのビルドだけは `INTERNET_EGRESS` を使い、実行時に閉域のコネクタへ切り替えます。Claude Code は `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` で、Bedrock 以外の通信を止めています。

**これで防げないこと:** 画面やターミナルからのコピー、撮影は止められません。正規の利用者による意図的な持ち出しを完全に防ぐものではなく、誤送信や、悪意あるパッケージとスクリプトによる送信を止める対策です。

### 11. ワークスペースは、ロールに S3 権限を渡さずに保存する

ロールは全員共通で、ターミナルから使えます。ここに S3 権限を付けると、他人のワークスペースも読めてしまいます。そこで、実行ロールには `workspace-url` 関数の呼び出しだけを許可し、関数がセッションごとの秘密トークンを確認して、その所有者のアーカイブだけに届く15分の署名付き URL を返します。HTTP API は閉域から届かないので、VPC エンドポイント経由で Lambda を直接呼びます。

保存は5分ごとに変更があれば実行し、サスペンド時と終了時にも実行します。復元に失敗したセッションは保存を止めます。空のワークスペースで保存済みの内容を上書きしないためです。アーカイブはバージョニングしていて、既定で14日前まで戻せます。`node_modules` などは対象外です。

### 12. 利用者の停止は、Cognito の無効化だけでは足りない

Cognito のユーザーを無効にしても、起動中のセッション、発行済みの MicroVM トークン(最大60分)、ID トークンは残ります。`revoke-user` はセッションも終了させます。セッションの開始とアクセスのルートは Cognito に有効かどうかを毎回確認し、ID トークンの寿命は15分にしました。

### 13. Well-Architected Framework との対応

| 柱 | このパターンの対応 |
| --- | --- |
| 運用上の優秀性 | `smoke.mjs` で実際のセッションの経路を検査できる。Lambda、HTTP API、MicroVM ごとのログ |
| セキュリティ | セッションごとの VM 分離。Cognito による個人の識別。所有者単位のアクセス制御。受信ポートなしの EC2。HttpOnly と SameSite=Strict の Cookie。長期キーなし |
| 信頼性 | セッションの状態はコンピュートの実状態から読み直す。接続済みの WebSocket はトークン失効後も維持される。各セッションは単一コンピュートでフェイルオーバーはない |
| パフォーマンス効率 | MicroVM はスナップショットから数秒で起動し、1秒未満でレジューム。どちらも arm64。IDE の通信はコントロールプレーンを通らない |
| コスト最適化 | セッションがなければコンピュートは動かない。MicroVM の自動サスペンド、EC2 のスイープ、ユーザーごとの上限。NAT と CloudFront はパラメータで外せる |
| 持続可能性 | 使っていないセッションのコンピュートを解放する。Graviton と MicroVM を使う |

## 💰 コスト最適化

単価はリージョンごとに異なります。以下は構成を比べるための米国東部(バージニア北部)の定価です。実際の費用を見積もる前に、AWS の料金ページで確認してください。

| 項目 | 費用 | 発生条件 |
| --- | --- | --- |
| MicroVM(arm64、1 vCPU、2 GiB 基準) | 実行1時間で約 $0.126、サスペンド中はスナップショットが 1 GB 月 $0.08 | セッションごと |
| EC2 `t4g.medium` | 1時間 $0.0336、gp3 30 GiB で 月 $2.4 | セッションごと |
| NAT Gateway(`natType: 'gateway'`) | 1時間 $0.045(月 約 $32.85)+ 1 GB あたり $0.045 | **`ec2` を有効にすると常時** |
| NAT インスタンス(`natType: 'instance'`) | `t4g.micro` 1時間 $0.0084(月 約 $6.1)+ パブリック IPv4 月 約 $3.65 | **`ec2` を有効にすると常時** |
| CodeCommit | 5アクティブユーザーまで無料枠の範囲で利用可能 | リポジトリを使うとき |
| VPC エンドポイント(閉域) | 1個 1時間 $0.01(7個、1 AZ で月 約 $51)+ 1 GB あたり $0.01 | **閉域なら常時** |
| DNS Firewall | 100万クエリ $0.60 + ドメイン数に応じた少額 | 閉域なら常時 |
| CodeArtifact | 1 GB 月 $0.05 + 100万リクエスト $0.05 | 閉域のパッケージ取得 |
| S3(ワークスペース) | 1 GB 月 $0.023 | 保存量に応じて |
| Lambda@Edge | 100万リクエスト $0.60 + GB 秒 $0.00005001 | 方式 B の全 HTTP リクエスト |
| CloudFront | 個人利用なら無料枠に収まる | 方式 B |
| HTTP API、Lambda、DynamoDB、Cognito | 少人数ならほぼゼロ | 常時 |

セッションを起動しない限り、MicroVM のみの構成(`ec2` と `browserAccess` を外す)の固定費はほぼゼロです。EC2 版を残すと、NAT の固定費が加わります。検証環境では NAT インスタンスで月 $20 以上抑えられます。

**10人の目安(閉域、MicroVM のみ):** 1人1日8時間、月20日の実行で MicroVM が約 $200、エンドポイントなどの固定費が約 $55、Bedrock のトークン料金は別です。

コストの調整先:

- `microvm.maxIdleSeconds`: サスペンドまでの時間。開いたままのタブの通信がアイドルに影響する可能性があります(未検証)
- `microvm.suspendedSeconds`: スナップショットを保存し続ける時間の上限
- `ec2.maxRunningHours`、`ec2.instanceType`、`ec2.volumeSizeGiB`
- `controlPlane.maxActiveSessionsPerOwner`
- `operations.dailyBedrockTokenLimit`、`operations.monthlyBudgetUsd`、`operations.alarmEmail`

## 🔒 セキュリティ考慮事項

### 実装済み

- セッションごとの VM 分離、ユーザー単位のコンピュート
- すべてのセッション操作に Cognito JWT を要求。セルフサインアップは無効
- 他のユーザーのセッションは常に 404
- CodeCommit の権限は指定したリポジトリの `GitPull` と `GitPush` だけ
- MicroVM トークンは1つの MicroVM の1ポートに限定、有効期間は最大60分
- Cookie は `__Host-` プレフィックス、`Secure`、`HttpOnly`、`SameSite=Strict`
- Lambda@Edge はエンドポイントの形式を検証し、Cookie を code-server へ転送しない
- EC2: プライベートサブネット、インバウンドルールなし、IMDSv2 必須、暗号化ボリューム、code-server はループバックのみ
- EC2 の操作と Session Manager はタグ付きインスタンスに限定、ドキュメントはポートフォワードのみ
- ポータルは CSP(nonce)を設定し、ID トークンをストレージに保存しない
- Bedrock の権限は設定した2つのモデルに限定

### 残るリスク

- **Cookie の中のトークン**: 方式 B では JWE トークンがブラウザにあります。スクリプトからは読めませんが、端末自体が侵害されれば有効期間内は使われます。
- **`--auth none`**: 方式 A と EC2 版では、`localhost:8443` に同じ端末のほかのプロセスが接続できます。共有端末では使わないでください。
- **Bedrock の費用**: 利用者はターミナルからモデルを直接呼べます。Bedrock の費用はユーザーごとに制限していません。
- **`internet` モードと EC2 版のアウトバウンド通信**: インターネットに自由に出られます。閉域にするか、[`claude-managed-agents-lambda-microvms`](../claude-managed-agents-lambda-microvms/README.ja.md) の Network Firewall パターンを参照してください。
- **監査の粒度**: ロールが共通なので、CloudTrail や Bedrock のログでは利用者を区別できません。セッションの開始とアクセスは、Lambda のログ(1年保持)に利用者と一緒に記録します。Bedrock の呼び出しログはアカウント全体の設定なので、このスタックでは変更しません。必要なら `aws bedrock put-model-invocation-logging-configuration` で有効にしてください。
- **MicroVM のエンドポイント**: トークンがあればどこからでも接続できます。接続元 IP の制限は、プラットフォーム側の機能としては確認していません。

### 意図的に範囲外としているもの(環境に応じて追加)

- CloudFront と HTTP API の AWS WAF
- Cognito の Plus 機能プランと SSO 連携
- カスタムドメインと証明書(デフォルト証明書では最小 TLS バージョンを指定できない)
- CloudFront のアクセスログと VPC フローログ
- EC2 版のワークスペース保存(EBS は停止中も残るが、セッション期限で消える)

### CDK Nag

`test/compliance/cdk-nag.test.ts` が、4つのスタックに AwsSolutions パックを適用します。抑制にはそれぞれ理由を付けています。

## 📋 前提条件

**デプロイする人**

- Node.js 20 以上と、リポジトリの依存関係(`infrastructure/` で `npm ci`)
- 対象リージョンで Lambda MicroVMs が有効なこと: `aws lambda-microvms list-managed-microvm-images`
- 対象リージョン**と us-east-1** での CDK ブートストラップ(方式 B を使う場合)
- `bedrock` に設定するモデルのアクセス(`aws bedrock-runtime converse` で確認)

**使う人**

- 方式 A: Node.js 20 以上
- 方式 B: ブラウザ
- EC2 版: Node.js 20 以上と [`session-manager-plugin`](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)

## 🚀 デプロイ手順

```sh
cd infrastructure/workspaces/code-server-session-control-plane

# Lambda@Edge のため、リージョンを明示する必要がある
export CDK_DEFAULT_REGION=ap-northeast-1 CDK_DEFAULT_ACCOUNT=<account>
PROJECT=<project> ENV=dev npx cdk deploy '**' --require-approval never --profile <profile>

# ユーザーを作る(UserPoolId はスタックの出力)
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username you@example.com --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> --username you@example.com \
  --password '<強力なパスワード>' --permanent
```

## 使い方

### 方式 B: ブラウザのみ

スタックの出力 `PortalUrl` を開き、サインインして **Start a new session** を押します。MicroVM が起動すると IDE に切り替わります。

トークンの有効期間は60分です。接続済みの IDE は使い続けられますが、60分を過ぎて再読み込みするとポータルへ戻るので、もう一度サインインして **Open** を押します。セッションと開いているファイルはそのままです。

### 方式 A と EC2 版: `session.mjs`

```sh
cd infrastructure/workspaces/code-server-session-control-plane/scripts

export CS_API_URL=<ApiUrl> CS_CLIENT_ID=<UserPoolClientId>
export CS_USERNAME=you@example.com CS_PASSWORD='...'

node session.mjs start                  # MicroVM
node session.mjs start --compute ec2    # EC2
node session.mjs connect                # 表示された http://localhost:8443 を開く

node session.mjs status
node session.mjs suspend
node session.mjs resume
node session.mjs stop
```

リレーは残り5分になる前にトークンを更新するので、作業中はそのターミナルを開いたままにしてください。EC2 の初回は code-server のインストールに約100秒かかります。

### CodeCommit

code-server のターミナルで、通常の Git 操作をそのまま実行します。パスワードやキーの入力は要りません。新しいブラウザの初回は VS Code の **Trust Folder & Continue** を押してください。

```sh
git clone https://git-codecommit.<region>.amazonaws.com/v1/repos/<リポジトリ名>
cd <リポジトリ名>
git add . && git commit -m "..."
git push origin HEAD:main
```

### MFA と利用者の管理

`requireMfa` を有効にすると、次のサインインでポータルが認証アプリの登録を求めます。表示されるキーを認証アプリに追加し、コードを入力してください。CLI ではコードを1回入力すると、12時間はリフレッシュトークンで更新を続けます(`~/.code-server-sessions-auth.json`、権限 600)。

利用者を止めるときは、次を実行します。ユーザーの無効化、サインアウト、全セッションの終了をまとめて行います。

```sh
aws lambda invoke --function-name <RevokeUserFunctionName> \
  --cli-binary-format raw-in-base64-out --payload '{"username":"user@example.com"}' /tmp/revoke.json
```

### 閉域でパッケージを使う

npm と pip は、起動時に CodeArtifact のミラーへ自動で向きます。ほかのツールやレジストリは使えません。VS Code の拡張機能は Open VSX に届かないので、Dockerfile でイメージに入れてください。

### Claude Code

Claude Code パネルを開くか、ターミナルで `claude` を実行します。Amazon Bedrock と `parameters/dev-params.ts` のモデルを使います。

## 🧪 テスト戦略

```sh
npm run test:unit -w workspaces/code-server-session-control-plane        # リソースと Lambda@Edge のロジック
npm run test:snapshot -w workspaces/code-server-session-control-plane    # テンプレート全体とリソース数
npm run test:compliance -w workspaces/code-server-session-control-plane  # cdk-nag AwsSolutions パック
```

`cdk deploy` だけでは、ブラウザから IDE に届くことは証明できません。`scripts/smoke.mjs` が実際のセッションを起動して経路を検査し、終了させます。

```sh
node scripts/smoke.mjs relay
CS_DOMAIN=<DistributionDomainName> node scripts/smoke.mjs browser
node scripts/smoke.mjs tunnel
```

## ⚙️ カスタマイズ

### 使う経路だけをデプロイする

```typescript
const devParams: EnvParams = {
  microvm: { baseImageArn: '...', baseImageVersion: '1' },
  // ec2 を書かなければ VPC と NAT Gateway を作らない
  browserAccess: false, // CloudFront と Lambda@Edge を作らない
};
```

### CodeCommit のリポジトリを指定する

```typescript
codeCommit: {
  repositoryNames: ['team-app', 'team-infra'],   // 既存。権限だけを付ける
  managedRepositoryNames: ['sandbox'],           // スタックで作成し、一緒に削除する
},
```

同じアカウントとリージョンのリポジトリが対象です。`managedRepositoryNames` のリポジトリは、スタックを削除すると中身ごと消えます(`isAutoDeleteObject` が有効な場合)。残したいものは `repositoryNames` に書いてください。

### NAT を切り替える

```typescript
ec2: {
  natType: 'instance',          // 既定は 'gateway'
  natInstanceType: 't4g.micro', // 既定値。arm64 のサイズを指定する
},
```

NAT インスタンスは費用を抑えられますが、単一障害点で、パッチ適用も自分で行います。検証環境向けで、共用環境には `gateway` を使ってください。`t4g.nano` は使えません(下記の不具合を参照)。起動後にサイズを変えても UserData は再実行されないので、作り直すには一度 `gateway` に戻します。

### Claude Code を無効にする、またはモデルを変える

```typescript
bedrock: {
  enabled: false,
  modelId: 'jp.anthropic.claude-sonnet-4-6',
  smallFastModelId: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
},
```

### 閉域と EC2 版を切り替える

```typescript
// 閉域(MicroVM のみ)
microvm: { baseImageArn: '...', baseImageVersion: '1', egress: 'private' },

// インターネットあり(EC2 版も使える)
microvm: { baseImageArn: '...', baseImageVersion: '1', egress: 'internet' },
ec2: { natType: 'instance' },
```

`egress: 'private'` と `ec2` を同時に指定すると、合成時にエラーになります。EC2 のセットアップにインターネットが必要で、閉域にならないためです。閉域の EC2 には、必要なものを焼き込んだ AMI が必要です。

### 作業内容を残す

MicroVM の `~/project` と VS Code の設定は自動で保存され、次のセッションで復元されます。保存の間隔は5分なので、直前の変更は失われることがあります。Git への push も併用してください。同じ利用者がセッションを2つ開くと、後に保存したほうが残ります(以前の版は S3 のバージョニングから戻せます)。EC2 版は対象外です。

## ✅ 実機デプロイ検証

2026-11-05 に開発用アカウントの ap-northeast-1 と us-east-1 へデプロイし、外部から確認しました。検証後にすべて削除しています。

| 確認項目 | 結果 |
| --- | --- |
| スタックの作成 | `Ec2` 約3分、`Microvm` 約5分(イメージビルドを含む)、`ControlPlane` 約2分、`BrowserAccess` 約4分 |
| MicroVM の起動から `RUNNING` | 7〜21秒(6回) |
| **実ブラウザ(方式 B)** | ポータルでサインイン、セッション開始から IDE の表示まで14秒。ターミナルと Claude Code 拡張が動作 |
| 方式 B の Cookie | `HttpOnly`、`Secure`、`SameSite=Strict`。`document.cookie` からは見えない。約1 KB で上限に余裕がある |
| 方式 B の WebSocket | Cookie あり 101。別オリジン 403。Cookie なしはポータルへの 302 |
| 方式 A | ヘルスチェック、ワークベンチ、WebSocket が 200、200、101。別オリジン 403 |
| EC2 版 | 同じ検査が 200、200、101、別オリジン 403。AWS 認証情報なしで接続 |
| EC2 の構成 | パブリック IP なし、`IMDSv2 required`、code-server は `127.0.0.1:8080` のみ |
| EC2 の所要時間 | SSM オンライン33秒、code-server 起動102秒、再開後 `RUNNING` まで7秒 |
| EC2 の停止と再開 | プロジェクトのファイルが残り、code-server も自動で再起動 |
| Claude Code → Bedrock | MicroVM、EC2 とも `BEDROCK_OK` |
| 所有者の分離 | 別のユーザーからの GET、access、DELETE はすべて 404 |
| セッションの上限 | 3つ目は 409 |
| サスペンド後の最初のリクエスト | CloudFront 経由で0.7秒、200。状態は `RUNNING` に戻った |
| 終了した MicroVM へのページ遷移(無効なトークン) | ポータルへの 302 と Cookie の削除 |
| スイープ | 期限前は何もせず、`ExpiresAt` を過去にすると終了 |

**閉域、保存、停止、MFA**

| 確認項目 | 結果 |
| --- | --- |
| 閉域での起動 | `RUNNING` まで5秒以内、IDE 表示まで9〜17秒 |
| 外部サイト(example.com、github.com、npmjs、anthropic) | 名前解決できない |
| IP 直接(1.1.1.1) | タイムアウト |
| 他アカウントの S3 | 同一リージョンは `AccessDenied`、別リージョンはタイムアウト |
| 閉域での CodeCommit、Bedrock | push 成功、`BEDROCK_OK` |
| 閉域での npm、pip | `left-pad`、`six` をミラーからインストール |
| `npm publish` | ミラーに公開されなかった |
| 保存と復元 | セッションを終了して起動し直すと、ファイルと `.git` が戻った |
| 他のユーザーから | 別の利用者のファイルは見えない |
| ターミナルから S3 直接 | `AccessDenied` |
| 誤ったトークン | `workspace-url` が拒否 |
| 利用者の停止 | 再サインイン不可、発行済み ID トークンでもセッション開始とアクセスは 403、セッションは終了、更新も失敗 |
| MFA | 登録とサインインが成功。誤ったコードは拒否。パスワードだけではトークンなし |
| 閉域 + MFA の方式 A | 全項目成功 |

**CodeCommit と NAT の切り替え**

| 確認項目 | 結果 |
| --- | --- |
| MicroVM のターミナル(実ブラウザ) | `git clone` と `git push` が成功。push は2秒 |
| EC2(`t4g.micro` の NAT インスタンス経由) | `git clone` と `git push`、Bedrock が成功。code-server の起動は100〜170秒 |
| コミットの作成者 | `verify@example.com`、`verify`(Cognito のメールアドレス) |
| 許可していないリポジトリ | `fatal: unable to access` で拒否 |
| `natType` の切り替え | `instance` → `gateway` → `instance` をスタック更新で実施。`gateway` への更新は185秒 |

**トークンの失効(1分のトークンで計測)**

| 経過 | 新しいリクエスト | 接続済みの WebSocket |
| --- | --- | --- |
| 119秒まで | 200 | 維持 |
| 142秒 | `403 x-aws-proxy-error: UNAUTHORIZED` | 維持(ping に応答) |

指定した時間ぴったりには失効せず、約1分の猶予がありました。接続済みの WebSocket は失効の影響を受けません。

実機で見つかり、修正した不具合:

1. **エンドポイントのドメインは `lambda-microvm`(単数形)。** サービス名から `lambda-microvms` と推測した検証パターンが全リクエストを拒否しました。実際の形式は `<id>.lambda-microvm.<region>.on.aws` です。
2. **プレースホルダーのオリジンの `originPath` が MicroVM へ漏れた。** ドメインを差し替えても、オリジンの `path`(API のステージ)は残ります。すべての HTTP が 404 になる一方、code-server の WebSocket はパスを問わず 101 を返すので、WebSocket だけ成功するという紛らわしい症状でした。`request.origin.custom.path` を空にしました。
3. **`ec2:CreateTags` にボリュームも必要。** スタックのタグが起動テンプレートのタグ指定に伝播するので、`RunInstances` がボリュームにもタグを付けます。インスタンスだけを許可すると `UnauthorizedOperation` になります。
4. **`session-manager-plugin` がクライアントより長く生きる。** クライアントを止めてもプラグインが残り、ポートを占有しました。シグナルを転送しています。

5. **`t4g.nano` の NAT インスタンスは NAT として動かない。** メモリ 512 MiB では、起動時の `yum install iptables-services` が `Killed` になり、`iptables` が入りません。スタックの作成は成功し、ルートも正常に見えますが、プライベートサブネットからは外へ出られず、EC2 は Session Manager に登録されません。既定を `t4g.micro` にしました。

6. **閉域で code-server が起動待ちに間に合わなかった。** 1 vCPU の MicroVM で AWS CLI を2つ同時に動かすと、20秒の待ちを超えて `/run` が 500 になり、MicroVM が終了しました。パッケージの設定を code-server の起動後に回し、`/validate` で code-server と AWS CLI を動かして先読みさせたところ、IDE の表示が9〜17秒になりました。`/run` のタイムアウトの上限は60秒です。

確認できていないこと: VS Code のソース管理パネルからの Git 操作、ファイルのダウンロード無効化の画面上の動作、アラームと予算の実際の通知、実際の60分トークンの失効、開いたままのタブでのアイドル自動サスペンド、`maxRunningHours` による停止(期限切れの終了は確認済み)、方式 A と EC2 版の実ブラウザでの操作(HTTP と WebSocket の検査のみ)、複数ユーザーの同時利用。

## 🔧 トラブルシューティング

まず `scripts/smoke.mjs` を実行してください。どの段階で失敗するかが分かります。

### WebSocket は 101 なのに、HTTP がすべて 404 になる

Lambda@Edge のオリジンパスを確認します。code-server の WebSocket はパスを問わず 101 を返すので、パスの誤りが WebSocket の検査では見つかりません。

### Cookie があるのに、ポータルへ戻され続ける

Lambda@Edge の `ENDPOINT_PATTERN` が実際のエンドポイントと一致しているか確認します。Cookie の値の `~` より前がエンドポイントです。

### IDE の一部が動かなくなり、`403 UNAUTHORIZED` が出ている

トークンが失効しています。ページを再読み込みするとポータルへ戻るので、もう一度サインインして **Open** を押します。方式 A ではリレーが更新できているか、`CS_PASSWORD` が正しいかを確認します。

### `POST /sessions` が 500 を返す(EC2)

`CreateSessionFunction` のログを確認します。`UnauthorizedOperation` がリソース名を示します。`CreateTags` のときは、タグが付くリソース(インスタンス、ボリューム、ネットワークインターフェイス)がすべて許可されているか確認します。

### `Connection to destination port failed, check SSM Agent logs`

ポートフォワードはつながっていますが、code-server がまだ起動していません。初回は UserData が終わるまで約100秒かかります。進行状況は `/var/log/cloud-init-output.log` で分かります。

### `POST /sessions` が 409 を返す

ユーザーごとの上限です。`session.mjs list` で確認し、不要なセッションを `stop` します。

### 検査スクリプトでページ遷移の動作が再現しない

Node.js の `fetch` は `sec-fetch-mode` を `cors` に上書きします。ページ遷移を試すときは、`curl -H 'Sec-Fetch-Mode: navigate'` か実ブラウザを使ってください。

### EC2 が Session Manager に登録されない(NAT インスタンス)

NAT インスタンスのコンソール出力(`aws ec2 get-console-output`)に `Killed` や `iptables: command not found` がないか確認します。あれば、メモリ不足で NAT の設定が入っていません。`natInstanceType` を `t4g.micro` 以上にして、インスタンスを作り直してください。

### `git clone` が `unable to access` で失敗する

リポジトリ名が `codeCommit` のパラメータにあるか確認します。CodeCommit の設定は、反映後に起動したセッションから有効です。古いセッションは終了して起動し直してください。

### `Your software token has already been used once`

MFA の登録やサインインの直後は、同じ時間枠のコードを再利用できません。約1分待って次のコードを入力します。

### `POST /sessions` が失敗し、`ServiceQuotaExceededException` が出る

MicroVM のメモリのクォータ(`Max allocated ARM_64 MicroVM memory`)の上限です。既定が 8 GB のアカウントでは、2 GiB のセッションは同時に4つまでです。10人なら 20 GB 以上を Service Quotas で申請してください。`CapacityErrors` アラームで検知できます。

### `WORKSPACE_NOT_RESTORED.txt` がプロジェクトにできる

保存済みのワークスペースを復元できず、そのセッションでは保存を止めています。上書きを防ぐためです。セッションを終了して起動し直してください。MicroVM のログの `[workspace]` の行に原因が出ます。

### Claude Code がサインインを求める、または Bedrock が拒否する

`bedrock.smokeCheck: true` でデプロイすると、MicroVM のログストリームに `[bedrock-check]` の行が出ます。`AccessDeniedException` なら、`aws bedrock-runtime converse` で応答するモデルを `bedrock.modelId` に設定します。

## 🧹 クリーンアップ

スタックを削除しても、起動中のセッションは終了しません。先にすべて終了させてください。EC2 のインスタンスが残っていると VPC を削除できません。`isAutoDeleteObject` が有効だと、保存したワークスペースと、`managedRepositoryNames` のリポジトリも削除されます。

```sh
node scripts/session.mjs list
node scripts/session.mjs stop --session <id>

cd infrastructure/workspaces/code-server-session-control-plane
PROJECT=<project> ENV=dev npx cdk destroy '**' --force --profile <profile>
```

Lambda@Edge のレプリカの削除には時間がかかるので、`edge-lambda-stack-*` は最初の削除で失敗することがあります。時間をおいて、もう一度実行してください(検証では数十分後に成功)。CloudFront のディストリビューションを消した後なら、課金は発生しません。

## 📚 参考資料

### AWS ドキュメント

- [MicroVM の実行と利用(ライフサイクルフック、認証、WebSocket)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [Lambda@Edge のオリジンの変更と制限](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html)
- [CloudFront で WebSocket を使う](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)
- [Session Manager プラグインのインストール](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
- [AWS Lambda の料金](https://aws.amazon.com/lambda/pricing/)

### code-server

- [code-server](https://github.com/coder/code-server)
- [code-server の導入・認証・HTTPS 公開の解説(株式会社一創)](https://www.issoh.co.jp/tech/details/18117/)

### 関連アーキテクチャ

- [`code-server-ec2-vs-lambda-microvms`](../code-server-ec2-vs-lambda-microvms/README.ja.md): 1台の code-server を EC2 と MicroVM で動かし比べる。CloudFront 経由の常時稼働 EC2 はこちら
- [`lambda-microvms-codex-appserver`](../lambda-microvms-codex-appserver/README.ja.md): このコントロールプレーンの元になった Codex 版
- [`claude-managed-agents-lambda-microvms`](../claude-managed-agents-lambda-microvms/README.ja.md): MicroVM のアウトバウンド通信をドメインで制限する

## 📄 ライセンス

このプロジェクトは Apache License, Version 2.0 のもとで公開されています。詳細は [LICENSE](../../../LICENSE) を参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します。[コントリビューションガイド](../../../docs/contribution/CONTRIBUTING.md)を参照してください。

## 🏆 このリファレンスアーキテクチャについて

このリファレンスアーキテクチャは、認証基盤で個人を識別しながらブラウザ IDE をユーザーごとに起動する方法と、トークン認証付きのエンドポイントをブラウザにつなぐ2つの方法を示します。

**対象レベル**: 300(上級)

---

**注意**: これはリファレンス実装です。本番環境へデプロイする前に、要件と組織のポリシーに合わせて必ず見直してください。
