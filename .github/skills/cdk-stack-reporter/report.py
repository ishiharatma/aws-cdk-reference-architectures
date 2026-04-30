#!/usr/bin/env python3
"""
全環境スタック状況レポーター

CDK list でスタック名一覧を取得し、AWS CLI で各スタックの詳細を取得して
環境ごとにレポートを出力する。

使い方:
    python3 .github/skills/cdk-stack-reporter/report.py --project <project_name>
    python3 .github/skills/cdk-stack-reporter/report.py --project <project_name> --envs dev stage prod
    python3 .github/skills/cdk-stack-reporter/report.py --project <project_name> --region ap-northeast-1
    python3 .github/skills/cdk-stack-reporter/report.py --project <project_name> --infra-dir ./infra
"""

import subprocess
import json
import argparse
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path


DEFAULT_ENVIRONMENTS = ["dev", "stage", "prod"]
DEFAULT_REGION = "ap-northeast-1"


def run_cdk_list(project: str, env: str, infra_dir: str) -> list:
    """CDK list コマンドでスタック名一覧を取得する。

    CDK list の出力は以下の2パターンがある：
      - 通常形式:       ExampleDevDataStack
      - ネスト構造形式: ExampleDev/Data (ExampleDev-Data)

    ネスト構造の場合は括弧内の CloudFormation スタック名を使用する。
    """
    cmd = f'cd "{infra_dir}" && PROJECT={project} ENV={env} npm run list --silent 2>/dev/null'
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        return []
    lines = result.stdout.strip().split("\n")
    stack_names = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith(">") or line.startswith("info"):
            continue
        # "ExampleDev/Data (ExampleDev-Data)" → "ExampleDev-Data"（括弧内を優先）
        if "(" in line and line.endswith(")"):
            cf_name = line[line.index("(") + 1 : line.rindex(")")]
            stack_names.append(cf_name)
        else:
            stack_names.append(line)
    return stack_names


def get_stack_details(stack_name: str, profile: str, region: str) -> dict:
    """AWS CLI でスタック詳細を取得する。スタックが見つからない場合は None を返す。"""
    cmd = [
        "aws", "cloudformation", "describe-stacks",
        "--stack-name", stack_name,
        "--profile", profile,
        "--region", region,
        "--output", "json",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
        stacks = data.get("Stacks", [])
        return stacks[0] if stacks else None
    except json.JSONDecodeError:
        return None


def format_datetime_jst(dt_str: str) -> str:
    """ISO 形式の UTC 日時を JST（UTC+9）に変換して返す。"""
    if not dt_str:
        return "-"
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        jst = dt.astimezone(timezone(timedelta(hours=9)))
        return jst.strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return dt_str


def build_report(project: str, envs: list, region: str, infra_dir: str) -> str:
    """全環境のスタック状況レポート文字列を生成する。"""
    start_time = time.monotonic()
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        f"# {project} スタック状況レポート",
        f"生成日時: {now}  |  リージョン: {region}",
        "",  # 経過時間は全処理後に挿入するためプレースホルダー行
        "",  # 空行
    ]

    for env in envs:
        profile = f"{project}-{env}"
        lines.append(f"## {env.upper()} 環境（プロファイル: `{profile}`）")
        lines.append("")

        stack_names = run_cdk_list(project, env, infra_dir)
        if not stack_names:
            lines.append(
                "> ⚠️  スタック一覧の取得に失敗しました。"
                f"CDK list コマンドまたはプロファイル `{profile}` の認証を確認してください。"
            )
            lines.append("")
            continue

        lines.append("| スタック名 | ステータス | 作成日時 (JST) | 最終更新日時 (JST) | 削除保護 |")
        lines.append("|---|---|---|---|:---:|")

        for stack_name in stack_names:
            details = get_stack_details(stack_name, profile, region)
            if details is None:
                lines.append(f"| {stack_name} | ❓ 未デプロイ or 取得失敗 | - | - | - |")
                continue

            status = details.get("StackStatus", "-")
            created = format_datetime_jst(details.get("CreationTime", ""))
            updated = format_datetime_jst(details.get("LastUpdatedTime", ""))
            protection = details.get("EnableTerminationProtection", False)
            protection_icon = "🔏" if protection else "-"

            lines.append(
                f"| {stack_name} | {status} | {created} | {updated} | {protection_icon} |"
            )

        lines.append("")

    elapsed = time.monotonic() - start_time
    # プレースホルダー行（index 2）に経過時間を埋め込む
    lines[2] = f"取得時間: {elapsed:.1f} 秒"

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="全環境の CDK スタック状況をレポートする"
    )
    parser.add_argument(
        "--project",
        required=True,
        help="プロジェクト名（例: example）。プロファイル名 <project>-<env> に使用される",
    )
    parser.add_argument(
        "--envs",
        nargs="+",
        default=DEFAULT_ENVIRONMENTS,
        help=f"対象環境のリスト（デフォルト: {' '.join(DEFAULT_ENVIRONMENTS)}）",
    )
    parser.add_argument(
        "--region",
        default=DEFAULT_REGION,
        help=f"AWS リージョン（デフォルト: {DEFAULT_REGION}）",
    )
    parser.add_argument(
        "--infra-dir",
        default="./infra",
        help="CDK infra ディレクトリのパス（デフォルト: ./infra）",
    )

    args = parser.parse_args()

    infra_dir = str(Path(args.infra_dir).resolve())
    if not Path(infra_dir).is_dir():
        print(f"エラー: infra ディレクトリが見つかりません: {infra_dir}", file=sys.stderr)
        sys.exit(1)

    report = build_report(
        project=args.project,
        envs=args.envs,
        region=args.region,
        infra_dir=infra_dir,
    )
    print(report)


if __name__ == "__main__":
    main()
