# PHP2Shell (CVE-2026-109618 / CVE-2026-109619) の AWS WAF 緩和策を CloudFront と ALB で検証する - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

2026-10-21 に公開された PHP の脆弱性 **PHP2Shell**(CVE-2026-109618 / CVE-2026-109619、CVSS v4.0 9.2、認証不要の RCE)について、AWS Security Blog が示した **AWS WAF のカスタムルール 4 本**を、**CloudFront(本文の検査上限 16〜64 KB)と ALB(8 KB 固定)の両方**に適用し、実機で検知結果の違いを測ります。

オリジンは **修正済みの PHP 8.4.27**(PHP-FPM + nginx)を Lambda コンテナイメージ + Lambda Web Adapter で動かし、`php.ini` / FPM プールにブログ推奨のサーバー側緩和策を入れています。**脆弱なバージョンは使わず、攻撃コードも送りません。** テストはルールの条件に一致する(または意図的に外す)無害なリクエストだけです。

> [!IMPORTANT]
> AWS WAF は緩和策であり修正ではありません。PHP 8.2.35 / 8.3.36 / 8.4.27 / 8.5.12 以降への更新が唯一の完全な対策です(IPA 注意喚起・AWS Security Bulletin 2026-143-AWS)。

## 📑 目次

- [アーキテクチャ概要](#️-アーキテクチャ概要)
- [PHP2Shell と WAF ルールの対応](#-php2shell-と-waf-ルールの対応)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [検証結果](#-検証結果ap-northeast-1--us-east-1-に実機デプロイ)
- [Well-Architected との対応](#️-well-architected-との対応)
- [コスト](#-コスト)
- [セキュリティに関する考慮事項](#-セキュリティに関する考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [使い方(test-waf.sh)](#-使い方test-wafsh)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#️-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![アーキテクチャ図](overview.drawio.svg)

### 主要コンポーネント

- **Web ACL(CLOUDFRONT、us-east-1 の別スタック)**。ブログの 4 ルール(`PHP2Shell` / `Block-Multipart-FormData` / `Block-Oversize-Body` / `RateLimit-Posts`)と検証クライアントの IP 許可リスト(既定のアクションは BLOCK)。`AssociationConfig` で本文の検査上限を `KB_64` にしています。
- **Web ACL(REGIONAL、ALB に関連付け)**。同じルールから `RateLimit-Posts` を除いたもの(ALB からは CloudFront のエッジ IP しか見えないため)。本文の検査上限は 8 KB 固定で変更できません。
- **どの WAF のルールが検知したかをヘッダーで見分ける仕組み**。Block は `403` と `x-php2shell-blocked-by: <cloudfront|alb>:<ルール>` を返し、Count は `x-amzn-waf-php2shell-<層>-<ルール>: counted` をオリジンへのリクエストに挿入します。PHP アプリはこのヘッダーを `wafHeaders` として返すので、`curl` だけで、どの WAF のルールが検知したかがわかります。
- **CloudFront**。`CachingDisabled` + `AllViewer`、全メソッド許可。オリジンへのリクエストに `X-Origin-Verify` ヘッダー(値は Secrets Manager の生成値を動的参照)を付けます。
- **ALB**。パブリックサブネット 2 つ(NAT なし)。セキュリティグループは CloudFront の origin-facing マネージドプレフィックスリストと(検証時だけ)クライアントの /32 を許可。リスナーの既定アクションは 403 で、`X-Origin-Verify` が一致するか、検証クライアントの送信元 IP のときだけ Lambda に転送します。
- **Lambda(コンテナイメージ、x86_64、1024 MB)**。`php:8.4.27-fpm-alpine3.24` + nginx + Lambda Web Adapter 1.0.1。読み取り専用ファイルシステム・非 root で動くよう、すべての実行時パスを `/tmp` に寄せています。
- **WAF ログ**。両 Web ACL を `aws-waf-logs-*` の CloudWatch Logs に出力(CloudFront 用は us-east-1)。`requestBodySizeInspectedByWAF` と `oversizeFields` で検査範囲を確認できます。

### スタック

| スタック | リージョン | 内容 |
|-------|--------|----------|
| `<project>-<env>-waf-php2shell-mitigation-waf` | us-east-1 | CloudFront 用 Web ACL、IP セット、WAF ログ |
| `<project>-<env>-waf-php2shell-mitigation` | ap-northeast-1 | VPC、ALB + Web ACL、Lambda、Secrets Manager、CloudFront、WAF ログ |

## 🧩 PHP2Shell と WAF ルールの対応

| CVE | 内容 | 確認済みの引き金 | このパターンでの対策 |
|-----|------|-----------------|---------------------|
| CVE-2026-109619 | 前のリクエストが残したグローバル状態を、同じワーカーの次のリクエストが再利用する | `PHP_SESSION_UPLOAD_PROGRESS`(セッションのアップロード進捗) | WAF: `PHP2Shell` ルール / PHP: `session.upload_progress.enabled=0`、`pm.max_requests=1` |
| CVE-2026-109618 | リクエスト処理中の PHP のメモリ不足でメモリ破壊 | `multipart/form-data` の大きな本文、`fatal_error_backtraces`(8.5) | WAF: `Block-Oversize-Body` / `Block-Multipart-FormData` / PHP: `memory_limit=-1`(上限は Lambda のメモリ)、`post_max_size=8M` |

| ルール | 優先度 | 条件 | 本パターンの既定 |
|-------|-------|------|-----------------|
| `PHP2Shell` | 0 | POST かつ `PHPSESSID`(Cookie のキー完全一致、または本文に含む)かつ本文に `PHP_SESSION_UPLOAD_PROGRESS` | 両層 BLOCK |
| `Block-Multipart-FormData` | 1 | `content-type` に `multipart/form-data`(LOWERCASE 変換後) | 両層 COUNT(アップロードがあるアプリでは BLOCK にできない) |
| `Block-Oversize-Body` | 3 | 本文 > しきい値、`OversizeHandling: MATCH` | CloudFront: **65,536 バイト超で BLOCK** / ALB: 8,192 バイト超で COUNT |
| `RateLimit-Posts` | 4 | POST が IP あたり 60 秒で 100 件超 | CloudFront のみ COUNT |

WAF では対処できないもの(ブログ記載): パートヘッダーによるメモリ増幅、`fatal_error_backtraces`、INI 診断。

## 🎯 設計判断とベストプラクティス

### 1. オリジンは修正済み PHP、検証対象は WAF の判定だけ

WAF の判定はオリジンの PHP バージョンに依存しません。脆弱な PHP をインターネットに置く必要はないので、修正版 8.4.27 を使い、テストもルール条件に当てはまるだけの無害な文字列にしています。オリジンは「WAF を通過したリクエストが実際に PHP-FPM まで届いたか」と「Count ルールの痕跡」を返すエコーです。

### 2. CloudFront の検査上限は 64 KB、Oversize のしきい値も 64 KB に揃える

`PHP2Shell` ルールは本文のうち検査上限までしか見ません(`OversizeHandling: CONTINUE`)。上限を超えた位置に文字列を置けば素通りします。ブログの `Block-Oversize-Body`(8 KB 超で BLOCK)はこの隙間を塞ぎますが、8〜64 KB の正規の本文まで止めます。CloudFront では **検査上限を 64 KB に上げ、Oversize のしきい値を 65,536 バイトにする**と、「見えない部分」がなくなり、かつ 64 KB までの正規リクエストは通ります(検証結果 4b)。

### 3. ALB の Web ACL は CloudFront の背後では「2 枚目の網」になる

CloudFront 経由のリクエストも ALB の Web ACL を通ります。ALB で 8 KB の Oversize を BLOCK にすると、CloudFront が 64 KB まで検査して通した正規リクエストを ALB が止めます(検証結果 4a)。そのため本パターンでは ALB の Oversize を COUNT にしています。ALB 側の 8 KB の隙間は、ALB への直接アクセスを閉じることで扱います(次項)。

### 4. オリジン(ALB)への直接アクセスを閉じる

ALB に直接届く経路は CloudFront の 64 KB 検査を迂回します。本パターンは 2 段で閉じます。

- **セキュリティグループ**: `com.amazonaws.global.cloudfront.origin-facing` プレフィックスリスト(`ec2.PrefixList.fromLookup`)からの 80 番だけ許可。
- **リスナールール**: プレフィックスリストは全 CloudFront ディストリビューション共通なので、`X-Origin-Verify` ヘッダーが一致したものだけ転送(既定アクション 403)。

検証のための直接アクセス(`verification.allowDirectAlbAccess`)を `false` にすると、直接の `curl` はタイムアウトします(検証結果 5)。本番では CloudFront VPC オリジン(内部 ALB)にするのがより確実です([`cloudfront-vpc-origin`](../cloudfront-vpc-origin/) 参照)。

### 5. レート制限は CloudFront 側だけ

ALB の Web ACL から見える送信元 IP は CloudFront のエッジです。ここで IP 単位のレート制限をかけると、複数のクライアントが同じエッジ IP にまとめられます。`X-Forwarded-For` を使う方法もありますが、先頭の値はクライアントが詐称できます。そのため、レート制限は実際のクライアント IP が見える CloudFront だけに置いています。

### 6. PHP 側の緩和策は php.ini と FPM プールで固定する

ブログの推奨どおり、リクエスト単位の上書き(`.htaccess` / `PHP_VALUE`)ではなく、イメージに焼き込んだ設定で適用しています。`pm.max_requests=1` により、Lambda 上でもリクエストごとに FPM ワーカーが入れ替わります(`/info` の `workerPid` が毎回変わることを確認済み)。

### 7. Lambda コンテナ + Lambda Web Adapter

ECS を常時起動せずに「本物の PHP-FPM」をオリジンにできます。ALB のターゲットにできるので、CloudFront → ALB → PHP の構成をそのまま保てます。なお、PHP は Lambda Web Functions(Node.js の zip 専用)では動かせません。

## 🔬 検証結果(ap-northeast-1 / us-east-1 に実機デプロイ)

2026-10-22 に [`test-waf.sh`](test-waf.sh) で計測しました(各ケース 1 回の送信)。`cf` は CloudFront 経由、`alb` は ALB への直接アクセスです。`counted` はオリジンに届いた Count ヘッダーです。

### 1. ルール条件(クラスメソッドの ALB 検証を両層で再現)

| リクエスト | cf | alb |
|-----------|----|-----|
| POST、Cookie `PHPSESSID` + 本文 `PHP_SESSION_UPLOAD_PROGRESS` | 403 `cloudfront:PHP2Shell` | 403 `alb:PHP2Shell` |
| POST、本文に両方 | 403 | 403 |
| POST、Cookie `a=1; PHPSESSID=x` + 本文 PROGRESS | 403 | 403 |
| POST、本文 PROGRESS のみ / Cookie のみ | 200 | 200 |
| PUT、本文に両方 | 200 | 200 |
| multipart の PROGRESS フィールド + Cookie | 403 | 403 |
| **Cookie キーが小文字 `phpsessid`** | **200** | **200** |
| **本文が小文字 `php_session_upload_progress`** | **200** | **200** |
| JSON / text/plain の本文に両方の文字列(誤検知) | 403 | 403 |
| 通常のファイルアップロード / `Multipart/Form-Data` | 200、`multipart` を COUNT | 200、`multipart` を COUNT |

文字列一致は `TextTransformation: NONE` のため大文字小文字を区別します。PHP の既定名(`PHPSESSID`、`PHP_SESSION_UPLOAD_PROGRESS`)と同じ表記だけが対象です。**`session.name` や `session.upload_progress.name` を既定値から変えているアプリでは、ルールの文字列もその名前に合わせる必要があります。**

### 2. 文字列の位置と検査上限(Cookie `PHPSESSID`、PROGRESS の終端バイト位置 N)

| N | ALB 直接 | CloudFront `KB_16` | CloudFront `KB_64` |
|---|---------|--------------------|--------------------|
| 8,192 | 403 | 403 | 403 |
| 8,193 | **200** | 403 | 403 |
| 16,384 | 200 | 403 | 403 |
| 16,385 | 200 | **200** | 403 |
| 32,769 / 65,536 | 200 | 200 | 403 |
| 65,537 / 100,000 | 200 | 200 | **200** |

(Oversize ルールは COUNT の状態)境界は 8,192 / 16,384 / 65,536 バイトちょうどでした。WAF ログの `requestBodySizeInspectedByWAF` も ALB は `8192`、CloudFront `KB_64` は `65536` で、上限を超えた本文には `oversizeFields: ["REQUEST_BODY"]` が記録されます。

### 3. Oversize ルールを BLOCK(しきい値 8,192、両層)

文字列の位置に関係なく、8,193 バイト以上は ALB 直接でも `alb:Oversize`、CloudFront 経由でも 64 KB 以内は `cloudfront:PHP2Shell`、それ以上は `cloudfront:Oversize` で 403 になります。代わりに、**ルール文字列を含まない約 19 KB の正規の JSON POST も 403** になります。

### 4. 層ごとにしきい値を変える

| 設定 | 19 KB の正規 JSON(cf) | PROGRESS が 65,537 バイト目(cf) | PROGRESS が 8,193 バイト目(alb 直接) |
|------|------------------------|-------------------------------|----------------------------------|
| 4a: CF Oversize 65,536 BLOCK / ALB 8,192 **BLOCK** | **403 `alb:Oversize`**(CF は通したのに ALB が止める) | 403 `cloudfront:Oversize` | 403 `alb:Oversize` |
| 4b: CF Oversize 65,536 BLOCK / ALB 8,192 **COUNT**(本パターンの既定) | **200** | 403 `cloudfront:Oversize` | **200**(直接経路の隙間) |

4b では CloudFront 経由のリクエストに検査されない部分が残らず、64 KB までの正規リクエストは通ります。残る隙間は ALB への直接経路だけなので、次の 5 で閉じます。

### 5. ALB への直接アクセスを閉じる(`allowDirectAlbAccess: false`)

| 確認 | 結果 |
|------|------|
| ALB への直接 `curl` | 接続タイムアウト(セキュリティグループで遮断) |
| CloudFront 経由の `/info` | 200(PHP 8.4.27、`session.upload_progress.enabled=0`) |
| CloudFront 経由、PROGRESS が 20 KB 目 | 403 `cloudfront:PHP2Shell` |

### 6. その他の確認結果

| 確認 | 結果 |
|------|------|
| CloudFront の Web ACL が Count で挿入したヘッダー | ALB を経由してオリジンまで届く(`x-amzn-waf-php2shell-cloudfront-*`) |
| Block のカスタムレスポンスヘッダー | 名前はそのまま返る(`x-php2shell-blocked-by`、`x-amzn-waf-` は付かない) |
| `RateLimit-Posts`(100 件 / 60 秒、COUNT)に約 2.4 req/s で POST | **138 件目(開始 57 秒後)に初めて一致**。しきい値ちょうどでは反応しない |
| 1,048,576 バイトの本文(ALB 直接) | 200(Lambda に届く) |
| 1,100,000 バイトの本文(ALB 直接) | **413**(ALB → Lambda の 1 MB 制限)。ALB の WAF ログには記録されない |
| WCU(Web ACL のキャパシティ) | CloudFront 50 / ALB 45(`AWSManagedRulesCommonRuleSet` 単体は 700) |
| Lambda コンテナのコールドスタート | 初回 `Init Duration` 3.2 秒、次は 0.2 秒。最大メモリ使用量は約 48 MB |
| `pm.max_requests=1` | リクエストごとに FPM ワーカーが入れ替わる(`workerPid` が毎回変わる) |

## 🏛️ Well-Architected との対応

| 柱 | 対応 |
|----|------|
| 運用上の優秀性 | ルールのアクションとしきい値を `EnvParams` で層ごとに切り替え、Count で影響を確認してから Block にする手順を再現できる。`test-waf.sh` で判定を表にして確認できる |
| セキュリティ | WAF(2 層)+ オリジンへの直接アクセス制限(プレフィックスリスト + 共有シークレットのヘッダー)+ PHP 側の緩和策の多層防御。WAF ログで全リクエストの判定を追跡できる |
| 信頼性 | Lambda オリジンは AZ に依存せず、ALB は 2 AZ。WAF ルールは Count から段階的に導入できる |
| パフォーマンス効率 | WCU は 45〜50 と小さい。キャッシュ無効の動的オリジンでも WAF による追加の遅延は小さい |
| コスト最適化 | Lambda オリジンで常時起動のコンピュートが不要。NAT なしの VPC。マネージドルールグループを使わずカスタムルール数本で済ませる |
| 持続可能性 | 検証後は `cdk destroy` ですべて削除でき、アイドル時の Lambda はリソースを使わない |

## 💰 コスト

東京 + us-east-1 で常時稼働した場合の月額の目安(トラフィックは少量):

| 項目 | 単価 | 月額の目安 |
|------|------|-----------|
| ALB | $0.0243/時 + LCU | 約 $18 |
| AWS WAF Web ACL × 2 | $5 / Web ACL | $10 |
| AWS WAF ルール(CloudFront 5 本、ALB 3 本) | $1 / ルール | $8 |
| AWS WAF リクエスト | $0.60 / 100 万(CloudFront 経由は 2 つの Web ACL で課金) | 100 万リクエストで $1.20 |
| 本文の検査上限の拡張(`KB_64`) | 16 KB を超える本文のリクエストに限り、16 KB 増えるごとに 100 万あたり $0.30 | 16 KB 超のリクエスト 100 万件で最大 $0.90 |
| Lambda / CloudFront / Secrets Manager / CloudWatch Logs | 従量 | 数ドル以下 |

検証(デプロイ〜計測〜削除で数時間)にかかる費用は $1 未満です。マネージドルールグループ(`AWSManagedRulesCommonRuleSet` など)を足すと、グループごとに月 $1 と WCU が加わります。

## 🔒 セキュリティに関する考慮事項

- **WAF は修正ではない**。PHP の更新が最優先です。PHP 8.1 以前には正式な修正リリースがありません。PHP プロジェクトが 7.4 / 8.0 / 8.1 向けに最小限のソースのバックポートを公開しており、ディストリビューションや LTS ベンダーがバックポートを提供している場合もあります。それも使えない場合は、移行するまでアクセスの制限や遮断を検討してください(PHP の告知、CERT-EU 2026-018、IPA)。
- **文字列一致は大文字小文字を区別する**。`session.name` や `session.upload_progress.name` を変えているアプリでは、ルールの文字列も合わせてください(検証結果 1)。
- **オリジンへの直接アクセスを必ず閉じる**。CloudFront の 64 KB 検査は ALB への直接アクセスで迂回されます。`allowDirectAlbAccess` は検証のためだけのスイッチです。
- **CloudFront → ALB は HTTP**。検証用スタックにはドメインも証明書もないためです。本番では HTTPS リスナー(ACM)か CloudFront VPC オリジンを使ってください。`X-Origin-Verify` の値は CloudFront の設定画面に平文で表示されるので、定期的に変更してください(スタックを再デプロイすると値が新しくなります)。
- **誤検知**。`PHP2Shell` ルールは本文の種類を問わないため、両方の文字列を含む JSON や text/plain も止めます。`Block-Multipart-FormData` を BLOCK にすると、アップロード機能が動かなくなります。
- **IAM**。オリジンの関数は AWS API を呼ばないため、`AWSLambdaBasicExecutionRole`(ログの書き込み)だけを持ちます。CDK Nag で抑制した項目とその理由は [`test/compliance/cdk-nag.test.ts`](test/compliance/cdk-nag.test.ts) にあります。

## 📋 前提条件

- AWS CLI v2、Node.js 24、Docker(コンテナイメージのビルド。x86_64 ホストを想定)
- `ap-northeast-1` と `us-east-1` の両方で CDK ブートストラップ済み
- `test-waf.sh` を実行するには `curl`、`jq`、`python3` が必要

## 🚀 デプロイ手順

```bash
cd infrastructure
npm install

# 検証クライアントの IP(未指定ならデプロイ元のグローバル IP を自動で取得)
export ALLOWED_IPS=203.0.113.10

PROJECT=myproject ENV=dev npm run stage:deploy:all -w workspaces/waf-php2shell-mitigation
```

> [!NOTE]
> `bin/` は `process.env.ENV` を `-c env=` より優先します。シェルに別の `ENV` が設定されていると、`No parameters found for environment` で失敗します。

## 使い方(test-waf.sh)

```bash
cd infrastructure/workspaces/waf-php2shell-mitigation

# conditions / false-positive / offset / limits をまとめて実行
./test-waf.sh --project myproject --env dev

# 個別に実行
./test-waf.sh --project myproject --env dev --suite offset
./test-waf.sh --project myproject --env dev --suite ratelimit --rate-requests 250
```

出力例:

```
| case                                         | path | http | blocked-by                 | counted |
| PROGRESS ends at byte 65537                  | cf   | 403  | cloudfront:Oversize        | - |
| PROGRESS ends at byte 65537                  | alb  | 200  | -                          | alb-oversize |
```

検証結果 2〜5 を再現するには、[`parameters/dev-params.ts`](parameters/dev-params.ts) の `waf.cloudFront` / `waf.alb`(アクション、`oversizeBodyBytes`、`bodyInspectionLimit`)と `verification.allowDirectAlbAccess` を変えて再デプロイします。WAF の変更だけなら、デプロイは 1 スタックあたり 15 秒ほどで終わります。

## 🧪 テスト戦略

```bash
npm test -w workspaces/waf-php2shell-mitigation
```

| 種類 | ファイル | 内容 |
|------|---------|------|
| ユニット | `test/unit/php2shell-web-acl.test.ts` | ルールの順序、`PHP2Shell` の AND/OR 構造、Cookie のキー一致、`OversizeHandling`、Block / Count で付けるヘッダー、`KB_64`、IP 許可リスト、ログの出力先 |
| ユニット | `test/unit/waf-php2shell-mitigation-stack.test.ts` | ALB の Web ACL(REGIONAL、レート制限なし)、SG のプレフィックスリスト、リスナールール(ヘッダー / 送信元 IP)、直接アクセスを閉じたときの構成、Lambda イメージ、CloudFront の設定 |
| スナップショット | `test/snapshot/snapshot.test.ts` | 両スタックのテンプレート全体とリソース数 |
| コンプライアンス | `test/compliance/cdk-nag.test.ts` | 両スタックに `AwsSolutionsChecks`(抑制には理由を付けている) |

## ⚙️ カスタマイズ

| パラメーター | 既定値 | 説明 |
|-------------|-------|------|
| `waf.cloudFront.ruleActions` | PHP2Shell と Oversize が BLOCK、ほかは COUNT | ルールごとの `BLOCK` / `COUNT` |
| `waf.cloudFront.oversizeBodyBytes` | 65536 | Oversize のしきい値。検査上限と揃える |
| `waf.cloudFront.bodyInspectionLimit` | `KB_64` | `KB_16` / `KB_32` / `KB_48` / `KB_64` |
| `waf.cloudFront.rateLimitPostsPerIp` | 100 | IP あたり 60 秒間の POST 数 |
| `waf.alb.ruleActions` | PHP2Shell が BLOCK、ほかは COUNT | ALB 側のアクション |
| `waf.alb.oversizeBodyBytes` | 8192 | ALB 側の Oversize のしきい値 |
| `origin.memorySize` | 1024 | Lambda のメモリ。`memory_limit=-1` のため、これが PHP の実際のメモリ上限になる |
| `verification.allowDirectAlbAccess` | true(dev) | 検証クライアントから ALB への直接アクセスを許可する。本番では false |

## 🔧 トラブルシューティング

| 症状 | 原因と対処 |
|------|-----------|
| まず状況を確認したい | `./test-waf.sh --suite conditions` で、どの層のどのルールが反応しているかを確認する |
| `No parameters found for environment: local` | シェルの `ENV` が優先されている。`ENV=dev` を付けて実行する |
| CloudFront 経由がすべて 403(`blocked-by` なし) | IP 許可リストに一致していない(既定のアクションで BLOCK)。`ALLOWED_IPS` を確認して再デプロイする |
| ALB への直接アクセスがタイムアウトする | `allowDirectAlbAccess: false` か、送信元 IP が `ALLOWED_IPS` と異なる |
| ALB への直接アクセスが 403 `Direct access denied` | リスナーの既定アクション。送信元 IP がリスナールールに一致していない |
| 1 MB を超える本文が 413 | ALB → Lambda のペイロード上限。WAF の判定ではない |
| デプロイ直後に結果が変わらない | WAF の変更が反映されるまで数十秒かかることがある。20 秒ほど待ってから再実行する |

## 🧹 クリーンアップ

```bash
PROJECT=myproject ENV=dev npm run stage:destroy:all -w workspaces/waf-php2shell-mitigation
```

ロググループは `RemovalPolicy.DESTROY`、シークレットは削除予約(復元期間あり)になります。ECR に push されたコンテナイメージは CDK の共有アセットリポジトリに残ります。

## 📚 参考資料

- [AWS WAF を使用した PHP2Shell RCE 脆弱性 (CVE-2026-109618 および CVE-2026-109619) の緩和策(AWS ブログ)](https://aws.amazon.com/jp/blogs/news/using-aws-waf-to-apply-mitigations-for-php2shell-rce-vulnerabilities-cve-2026-109618-and-cve-2026-109619/)
- [AWS Security Bulletin 2026-143-AWS](https://aws.amazon.com/security/security-bulletins/2026-143-aws/)
- [IPA: PHP の脆弱性(PHP2shell)に関する注意喚起](https://www.ipa.go.jp/security/security-alert/2026/alert20261022.html)
- [PHP security advisory: Critical remote code execution vulnerabilities, update now(2026-10-21)](https://www.php.net/archive/2026.php#2026-10-21-5)
- [CERT-EU Security Advisory 2026-018: Critical Vulnerabilities in PHP](https://cert.europa.eu/publications/security-advisories/2026-018/)
- [NCSC-NL php2shell operational information](https://github.com/NCSC-NL/php2shell)
- [Amazon Threat Intelligence: PHP2Shell の公開前の悪用を MadPot で観測](https://aws.amazon.com/blogs/security/amazon-threat-intelligence-identifies-php2shell-exploitation-prior-to-public-disclosure-in-madpot/)
- [クラスメソッド: AWS Security Bulletin と AWS Security Blog の WAF ルールを試した](https://dev.classmethod.jp/en/articles/aws-security-bulletin-php2shell-waf-rules/)
- [AWS WAF: Considerations for managing body inspection](https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-setting-body-inspection-limit.html)
- [AWS WAF 料金](https://aws.amazon.com/waf/pricing/)
- [Lambda functions as targets of an Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html)
- [AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter)
