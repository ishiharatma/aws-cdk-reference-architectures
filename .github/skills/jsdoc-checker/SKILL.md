---
name: jsdoc-checker
description: ソースコードの JSDoc コメント整合性と TypeDoc 生成を検証するスキル。「JSDoc を確認して」「ドキュメントの整合性をチェックして」などと言われたときに使用する。
---

# JSDoc 整合性チェックスキル

## 検証の実行方法

```bash
bash .github/skills/jsdoc-checker/scripts/check-jsdoc.sh
```

## チェック項目一覧

| # | カテゴリ | 検証内容 | 重要度 |
|---|---|---|---|
| 1 | export class/interface | `export class` / `export interface` の直前に `/** */` JSDoc があるか | 必須 |
| 2 | public readonly | Construct / Stack の `public readonly` プロパティの直前に JSDoc があるか | 必須 |
| 3 | constructor @param | Construct / Stack の constructor に `@param` 記載があるか | 推奨 |
| 4 | TypeDoc 生成 | `npx typedoc` がエラーなしで完了するか | 必須 |
| 5 | 生成物網羅性 | 主要 Construct / Stack が生成 HTML に含まれるか | 必須 |

## 判定基準

- `PASS`: JSDoc が存在する / TypeDoc 生成成功 / 生成物に含まれる
- `FAIL`: JSDoc が欠落 / TypeDoc 生成エラー / 生成物に不足
- `WARN`: constructor @param 未記載（推奨レベル）

## 対象ファイル

- `lib/constructs/*.ts` — カスタム Construct
- `lib/stacks/*.ts` — Stack 定義
- `lib/stages/*.ts` — Stage 定義
- `lib/types/*.ts` — 型定義・インターフェース
- `parameters/*.ts` — 環境パラメータ

## 使用タイミング

- 新しい Construct / Stack / 型を追加したとき
- TypeDoc 生成前の品質確認
- リリース前のドキュメント整合性チェック
