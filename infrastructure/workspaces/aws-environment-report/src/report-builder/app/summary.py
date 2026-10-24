"""Optional natural-language summary from Bedrock.

Only aggregates go to the model: totals, per-service cost, finding counts and
finding titles with severity. ARNs, account IDs and resource names are not
sent, and anything that still looks like an account ID is masked.
"""
import json
import re

ACCOUNT_ID = re.compile(r"\b\d{12}\b")
ARN = re.compile(r"arn:aws[a-z-]*:[^\s\"']+")

PROMPTS = {
    "ja": (
        "あなたはAWS環境の月次レポートを書く担当です。以下のJSONは収集済みの集計値です。"
        "事実はJSONにあるものだけを使い、推測で数値や原因を足さないでください。"
        "出力は日本語のプレーンテキストで、(1)全体の要点を3行以内、(2)優先して対応すべき事項を最大5件、"
        "重要度の高い順に箇条書き(『- 』で始める)にしてください。データソースが OK 以外のものは、"
        "その分の情報が欠けていることを必ず明記してください。"
    ),
    "en": (
        "You write the monthly report for an AWS environment. The JSON below holds collected aggregates. "
        "Use only facts present in the JSON; do not invent numbers or causes. Output plain text: "
        "(1) the overall picture in at most 3 lines, (2) up to 5 prioritized action items as '- ' bullets. "
        "State explicitly when a data source is not OK and its information is therefore missing."
    ),
}


def mask(text):
    return ACCOUNT_ID.sub("<account>", ARN.sub("<arn>", text))


def build_input(facts):
    return mask(json.dumps(facts, ensure_ascii=False, sort_keys=True))


def summarize(client, model_id, locale, facts):
    """Returns (status, text). Never raises: a failed summary must not fail the report."""
    try:
        res = client.converse(
            modelId=model_id,
            messages=[{"role": "user", "content": [{"text": f"{PROMPTS[locale]}\n\n{build_input(facts)}"}]}],
            inferenceConfig={"maxTokens": 1500, "temperature": 0},
        )
        parts = res["output"]["message"]["content"]
        text = "".join(p.get("text", "") for p in parts).strip()
        return ("OK", text) if text else ("ERROR", "empty response")
    except Exception as e:  # noqa: BLE001 - reported in the manifest instead
        return "ERROR", f"{type(e).__name__}: {str(e)[:300]}"
