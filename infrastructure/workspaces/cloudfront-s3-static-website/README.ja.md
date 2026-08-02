# XXXX

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## **Sorry!Under construction!!**

## アーキテクチャ概要

![overview](overview.drawio.svg)

- xxxx
- xxxx

### 主要コンポーネント

- xxxx
- xxxx

## デプロイ

```bash
export PROJECT=your-project
export ENV=dev

npm run bootstrap   # 初回のみ
npm run diff
npm run stage:deploy:all
```

### WAFの許可IP(v4/v6)

このワークスペースのCloudFrontディストリビューションにはWAFv2 Web ACLが付与されており、デフォルトでは`cdk deploy`を実行したマシン自身のグローバルIPだけが管理ルール適用後の許可リストに載ります（`bin/cloudfront-s3-static-website.ts`が`curl`でIPを自動検出）。IPv6は`curl -6`で取得を試み、取得できない環境（IPv6接続のないdevcontainer/CI等）では自動的にスキップされ、IPv4のみが許可リストに入ります。

自動検出ではなく、任意のIP（例: 実際にブラウザを開いている端末のIP)を明示的に許可したい場合は、環境変数`ALLOWED_IPS`/`ALLOWED_IPV6S`で上書きできます（カンマ区切りで複数指定可）。指定した場合は自動検出の`curl`呼び出し自体がスキップされます。

```bash
ALLOWED_IPS=203.0.113.10,203.0.113.20 \
ALLOWED_IPV6S=2001:db8::1 \
npm run stage:deploy:all
```

いずれのIPアドレスも指定・検出されなかった場合（両方とも未指定）は、WAFのIP制限自体が「全許可」になります。

## 使用方法

## クリーンアップ

## 料金

[XXXX - AWS 料金見積りツール](https://calculator.aws/#/estimate?id=XXXX)