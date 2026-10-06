# 鍵ローテーション

公開鍵は複数登録できるため、鍵を置き換えるのではなく、追加して切り替えてから削除します。

| 手順 | 作業 | コマンド |
|---|---|---|
| 現在 | 鍵Aのみ登録 | |
| 1 | 接続元が新しい鍵ペアを生成し、鍵Bの公開鍵を渡す | `ssh-keygen -t ed25519 -f new-key` |
| 2 | 鍵Bを追加（A、Bが併存） | `./update-transfer-user-key.sh --user system01 --add-key ./new-key.pub` |
| 3 | 接続元システムを鍵Bに切り替え、接続を確認 | |
| 4 | 鍵Aのフィンガープリントを確認し削除 | `./get-transfer-user.sh --user system01` → `./update-transfer-user-key.sh --user system01 --remove-fingerprint SHA256:...` |
| 最終 | 鍵Bのみ登録 | |

- 最後の1本の鍵は削除できません。接続を止める場合は `set-transfer-user-status.sh --disable` を使います
- 鍵の追加は先に行い、削除は後に行うため、どの時点でも有効な鍵が残ります
- 鍵の漏えいが疑われる場合は、手順2から4をすぐに実施します
