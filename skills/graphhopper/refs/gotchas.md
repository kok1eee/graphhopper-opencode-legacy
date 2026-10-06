## Gotchas

- **live-docs-first**: 版依存の主張（SDK API・MCP仕様・外部CLI挙動・言語仕様の版差）は
  推測で書かず、context7 / 公式docで裏付けてから書く・直す。裏が取れない版詳細は
  「版未確認」と明記する（typesafe SKILL.mdの作法）
- **コード探索のtier**: graft（意味・構造の入口）→ LSP（点照会: file＋line特定済みの定義・参照・hover・診断のみ）→ ast-grep（構造パターン: `ast-grep -p '<pattern>' <path>` / `ast-grep --rule rule.yaml`）→ rg（テキスト最終手段）。plain grep・findは使わない。graftの絞り込み前にlsp_workspace_symbolsを投げない（版ズレ・ノイズの温床）
- **`sg` は使わない**: macOSではast-grepのshimだが、Linux（Amazon Linux等）では newgrp へのsymlink＝「別グループで任意コマンド実行」。canonical名 `ast-grep` のみ使う（allowlistはsgをdeny済み）
- **tgrepはtier外の逃走経路**: 表現力は rg と同じで、利点は巨大repoでの速度のみ。通常は rg で足りる。どうしても遅い巨大repoでのみ、自分で `tgrep index .` または `tgrep serve .` を立てて `tgrep search` を使う（index/serve は状態変更のため allowlist では deny＝BYOS。stale index は取りこぼしの原因になるので更新に注意）
- **書き換え系フラグは禁止**: `ast-grep --update-all` / `ast-grep -U`、`ruff --fix` / `ruff format`、`pyright --createstub` はsubagent read-only不変条件のためdeny。使わない
- **診断クリーンをdriftなしの根拠にしない**: 挙動driftは診断に出ない。診断は補助証拠
- **言語版ガード（critic/verifier共通の誤検知止め）**: 構文・APIの指摘前に requires-python / .python-version / toolchain の版を必ず確認する。Python 3.14+ では PEP 758 により括弧なし except（`except A, B:`）は有効な構文であり、版が 3.14+ なら指摘しない（警告が出る場合のみ言及）。版不明・3.13以前なら従来通り指摘してよい

- **designing中に無理にEdit/Writeしようとしてエラーになったら**: 設計が先という合図。design.md を先に書いてから implementing へ遷移する
- **designing終了後にdesign.mdを書き直そうとしてエラーになったら**: 仕様変更や見落としがあっても design.md 自体は書き換えない。`.graphhopper/plans/<goal-id>.log.md` に決定の経緯・棄却した代替案を追記する（design.mdはverifierのdrift検出アンカーなので不変を保つ）
- **critic を呼ばずに implementing に飛ばない**: `graphhopper-critic` は毎goal必ず1回呼ぶ（安価な常設node）。飛ばすと設計段階の要件漏れ・スコープ逸脱が implementing まで持ち越される。critic の指摘は design.md に反映してから遷移する
- **route=polishなのに「念のため」でverifier fan-outを省略しない**: router_checkの判定はコード側の機械測定。無条件発火だったcouncilの再発防止はここで担保されている
- **simplify の diff を inline で subagent に渡さない**: main context を汚す。`graphhopper_diff_stash` の返却pathで渡す（verifierと共用。agent は bash deny なので自分で diff は取れない）
- **route=advisor なのに simplify を実行しない**: simplify は route=polish（大diff）のときだけの条件分岐 node。advisor（小diff）ではスキップが正しい。逆に polish で飛ばすのも禁止
- **1 goal 1 driver**: TUI bind中のgoalをMCP等別sessionから操作すると警告が出る（二重駆動防止）。
  意図的な引き継ぎなら session_id を指定して resume で bind し直す
- **非法遷移は拒否される**: designing→implementing→polish→done のみ（polish→implementing巻き戻し可）。
  特に `setPhase(done)` の直指定は不可（doneはverifier clean後のcompleteのみ）
- **simplify で critical を自動適用して設計を変えない**: interface / signature / 公開 API の振る舞いを変える提案は high 扱いで人間に提示。勝手に直すと design レベルの変更になる
- **simplify 適用後に eval_cmd を再実行しないで verifier に進まない**: critical 適用でコードが再変更されている。機械確認してから verifier を呼ぶ
- **route=advisorだからverifier呼び出し自体を省略しない**: 「小diffだから自分で見れば十分」は禁止。`graphhopper_verifier_set`はresultsが空だと機械的にエラーを返す（self-graded完了防止のゲート）ので、必ず`task(graphhopper-verifier, charter: 'general')`を1回呼んでから記録する
- **verifier fan-outへの指示を「重大な問題だけ報告」にしない**: 全件報告→機械集約が正しい順序（保守的な指示は再現率を落とす）。`results` に詰めるのは各charterの level そのまま。メインの裁量でdriftを握り潰さない（集約ルールがコード側にあるため握り潰せない）
- **`graphhopper_attempt`を省略しない**: 呼ばなければfail_streakが0のまま止まり、詰まっていても oracle への相談が起動しない。実装試行のたびに毎回呼ぶ
- **escalate: trueが出たのに自力でもう一度だけ試そうとしない**: 閾値はコード側の機械カウント。無視して回すと同じ失敗を繰り返すだけになりがちなので、必ずoracleに相談してから再試行する

- **モデル割当を変えたらTUI再起動**: 実行中セッションのagent→モデル束縛は古いまま残る（`task()`は初回解決を維持し、config変更が伝播しない実証あり。K7は現行minimaxではなく旧haikuで走った）。`graphhopper_invoke` は毎回configを読み直すため新割当が効く。subagent呼び出しはinvokeを優先し、fan-out前は最初に1件だけ投げてDBでモデルを確認せよ

- **config直書きはtmp+renameでatomicに**: `graphhopper.json` を直接dumpで書き換えると、同時刻のconfig読み出しとraceして壊れJSON→全agentモデル欠落→子が親mainを継承する。書換えは必ずtmp＋renameで行う
