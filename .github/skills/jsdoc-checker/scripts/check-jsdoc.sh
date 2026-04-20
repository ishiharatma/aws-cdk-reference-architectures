#!/usr/bin/env bash
# JSDoc 整合性チェックスクリプト
# infra/ ディレクトリから実行すること
set -euo pipefail

INFRA_DIR="${1:-$(cd "$(dirname "$0")/../../../../infra" && pwd)}"
PASS=0
FAIL=0
WARNINGS=0

red()   { printf "\033[31m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$1"; }

check_jsdoc_before() {
  local label="$1" pattern="$2"
  shift 2
  local files=("$@")
  local missing=()

  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    while IFS=: read -r line_num content; do
      prev_line=$((line_num - 1))
      prev=$(sed -n "${prev_line}p" "$f")
      if [[ ! "$prev" =~ \*/ ]]; then
        missing+=("  $f:$line_num: $content")
      fi
    done < <(grep -n "$pattern" "$f" 2>/dev/null || true)
  done

  if [ ${#missing[@]} -eq 0 ]; then
    green "✅ $label: 全て JSDoc あり"
    PASS=$((PASS + 1))
  else
    red "❌ $label: JSDoc なし ${#missing[@]} 件"
    for m in "${missing[@]}"; do echo "$m"; done
    FAIL=$((FAIL + 1))
  fi
}

echo "=== JSDoc 整合性チェック ==="
echo "対象: $INFRA_DIR"
echo ""

# 1. export class / export interface に JSDoc があるか
echo "--- 1. export class / interface ---"
target_files=()
while IFS= read -r f; do target_files+=("$f"); done < <(find "$INFRA_DIR/lib" "$INFRA_DIR/parameters" -name '*.ts' ! -name '*.test.ts' ! -name '*.spec.ts' 2>/dev/null)
check_jsdoc_before "export class/interface" "^export \(class\|interface\) " "${target_files[@]}"

# 2. public readonly プロパティに JSDoc があるか
echo ""
echo "--- 2. public readonly プロパティ ---"
construct_files=()
while IFS= read -r f; do construct_files+=("$f"); done < <(find "$INFRA_DIR/lib/constructs" "$INFRA_DIR/lib/stacks" "$INFRA_DIR/lib/stages" -name '*.ts' ! -name '*.test.ts' 2>/dev/null)
check_jsdoc_before "public readonly" "public readonly" "${construct_files[@]}"

# 3. constructor に @param JSDoc があるか（Construct/Stack のみ）
echo ""
echo "--- 3. constructor @param ---"
missing_param=()
for f in "${construct_files[@]}"; do
  [ -f "$f" ] || continue
  if grep -q "constructor(" "$f"; then
    # constructor の直前ブロックに @param があるか
    block=$(awk '/\/\*\*/,/constructor\(/' "$f" | tail -20)
    if echo "$block" | grep -q "@param"; then
      :
    else
      missing_param+=("  $f")
    fi
  fi
done
if [ ${#missing_param[@]} -eq 0 ]; then
  green "✅ constructor @param: 全て記載あり"
  PASS=$((PASS + 1))
else
  yellow "⚠️  constructor @param: 未記載 ${#missing_param[@]} 件"
  for m in "${missing_param[@]}"; do echo "$m"; done
  WARNINGS=$((WARNINGS + 1))
fi

# 4. TypeDoc 生成テスト
echo ""
echo "--- 4. TypeDoc 生成 ---"
if (cd "$INFRA_DIR" && npx typedoc --logLevel Error 2>&1); then
  green "✅ TypeDoc: エラーなし"
  PASS=$((PASS + 1))
else
  red "❌ TypeDoc: 生成エラー"
  FAIL=$((FAIL + 1))
fi

# 5. 生成物に主要モジュールが含まれるか
echo ""
echo "--- 5. 生成物の網羅性 ---"
ref_dir="$INFRA_DIR/docs/reference"
expected_classes=(
  "AlbConstruct" "EcsConstruct" "VpcConstruct" "WafConstruct"
  "ApiLoggingConstruct" "FileTransferConstruct" "CommitConstruct"
  "ApplicationStack" "DataStack" "PipelineStack" "CommitStack"
)
missing_docs=()
for cls in "${expected_classes[@]}"; do
  if ! find "$ref_dir/classes" -name "*${cls}*" 2>/dev/null | grep -q .; then
    missing_docs+=("$cls")
  fi
done
if [ ${#missing_docs[@]} -eq 0 ]; then
  green "✅ 生成物網羅性: 全 ${#expected_classes[@]} クラス確認"
  PASS=$((PASS + 1))
else
  red "❌ 生成物に不足: ${missing_docs[*]}"
  FAIL=$((FAIL + 1))
fi

# サマリ
echo ""
echo "=============================="
echo "PASS: $PASS / FAIL: $FAIL / WARN: $WARNINGS"
if [ "$FAIL" -gt 0 ]; then
  red "RESULT: FAIL"
  exit 1
else
  green "RESULT: OK"
fi
