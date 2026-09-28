---
name: graphhopper
description: "designing→implementing→polishのgoal駆動ループ。Use when: 複数ファイルにまたがる変更・設計判断を含む実装の依頼。単一ファイルの小修正・質問回答・一回きりのコマンド実行には使うな（直接やれ）。designing中はsource編集が物理ブロックされる。"
---

# graphhopper — designing/implementing/polish ループ

graphhopper本体（Claude Code版）の3相グラフをopencodeに移植したもの。
判断は「メイン + graphhopper-verifier(opus)」の2層で足りるという原則（council再発防止）を
そのまま踏襲する。専用の designer は作らない。ただし設計段階の質チェックとして
安価な `graphhopper-critic`（Luna 等）を designing で1回呼ぶ常設nodeを持つ
（verifier が実装後の drift 検出、critic が実装前の計画検証という役割分担）。

## どのnodeに何を振るか（typesafe流「need→手段」対応表）

| Need | 手段 | 使い分け |
|---|---|---|
| 計画の敵対検証 | critic（designingで1回） | 要件漏れ・設計の穴・スコープ逸脱。質はここ |
| 実装後のdrift検出 | verifier（polishでfan-out） | requirement/behavior/progressの3lens |
| 手詰まり打開 | oracle（escalate時のみ） | 失敗文脈を渡して助言のみ受け取る |
| repo内事実収集 | researcher（read-only） | graft-first。判断を含めない |
| repo外公式doc | librarian（read-only） | URL・引用付き。判断を含めない |
| 大diff整理 | simplify（route=polishのみ） | 提案のみ。適用はメイン |

独立した問いなら並列に投げ、メインが統合する。判断は増やさない（council再発防止）。

## フェーズ

```
designing → implementing → router_check → polish ─┬─ route=polish:  simplify → verifier ×3
                                                   └─ route=advisor: (simplify skip) → verifier ×1
                 ↑______________________________________|
                     drift target=implementing の巻き戻し
```

### designing

- `graphhopper_goal(action: "start", title: ...)` で開始すると
  `.graphhopper/plans/<goal-id>.md` の骨格が自動生成される（scaffold）。
  既存ファイルは壊さない
- 骨格（goal理解／現状／設計判断／タスク列／棄却＋タスク行）を埋める。
  **骨格不足だと `implementing` 遷移が機械拒否される**（構造のみ・質はcriticの領分）。
  中身をゼロから書く必要は無い、scaffoldを埋めればよい
- **このフェーズではsource編集（Edit/Write）が `tool.execute.before` hookで物理ブロックされる**
  （許可パスは `.graphhopper/plans/` 配下のみ、`.graphhopper/config.json` の `design_gate_allow` で変更可）
- 書けたら `task(subagent_type: "graphhopper-critic")` で**設計を1回敵対レビュー**する
  （要件漏れ・設計の穴・スコープ逸脱を検出。安価モデル = 常設nodeなので毎goal必ず呼ぶ。
  `require_critic: true` のプロジェクトでは機械ゲート化され、未記録だと implementing 遷移が拒否される）
- critic の指摘を design.md に反映してから `graphhopper_phase(phase: "implementing")`
- 要件の公式doc裏付けが必要なら `task(subagent_type: "graphhopper-librarian")` を使う
  （researcherはコードベース事実収集に専念し、外部調査はlibrarianに委ねる）
- 任意で `graphhopper_critic_set(level, reason)` に結果を記録できる（opt-in、`graphhopper_phase`
  の前提条件にはならない。self-graded防止機構は付けない——「critic を呼んだか」自体の
  機械チェックはしないので、記録するかどうかもメインエージェントの裁量）
- **design.md はこのフェーズを抜けた後は不変になる**（`tool.execute.before` が
  designing以外での該当パスへの書き込みを常にブロックする）。verifierがdrift検出の
  アンカーとして読むため、実装に合わせて書き直せると「driftをdesign.md側の書き換えで
  消せる」Goodhart's Lawの穴になる。決定の経緯・棄却した代替案・進捗は
  `.graphhopper/plans/<goal-id>.log.md`（design.mdとは別物、追記専用・ハードゲート無し、
  全phaseで自由に書ける）に持つ

### implementing

- design.md のタスクを1つずつ実装する
- goal中のsource編集は `graphhopper_hash` でhash取得→ `graphhopper_edit`（hash検証付き）を使え。
  素のedit/writeはフォールバック。拒否（throw）はhash再取得の合図
- 詰まったら `task(subagent_type: "graphhopper-researcher")` で並列調査。
  外部公式doc裏付けが必要なら `task(subagent_type: "graphhopper-librarian")` を使う
- researcher / librarian の使い分け（調査の内外分離。両方とも最安tier・read-only）:
  - researcher = repo**内**（定義・構造・呼び出し関係をgraft-firstで）。librarian = repo**外**
    （公式doc・仕様・実装例を webfetch / context7 で。URLと引用付き、判断なし。
    context7に無い一般web（issue・blog・changelog）はwebsearch MCP（Exa）、
    コード例はgrep.app MCPにフォールバック）
  - 独立した問いなら `task()` で2体を**並列**に呼び、メインが統合する（discover fan-outと同型）
  - 外部問いが内部findingsに依存するなら**直列**にする（researcherで対象ライブラリ・版を
    特定してからlibrarianにdocを引かせる。逆順・同時投げは版ズレの温床）
  - researcherは外部調査を自分でやらずlibrarian委譲を提案し、librarianは判断を含めない（境界の二重化）
- **実装試行のたびに `graphhopper_attempt(ok, note)` を呼ぶ**（成否をコード側で機械カウントする）。
  ただし **eval_cmd設定中はattemptを呼ばない**（idle/MCP-evalが自動記録するため二重計数になる。
  手動の進捗メモが必要ならnoteに残す）。eval未設定時のみ自己申告フォールバックとして使う
  - `ok: false` が続き `fail_streak` が `stuck_threshold`（既定3）に達すると `escalate: true` が返る
  - `escalate: true` が返ったら `task(subagent_type: "graphhopper-oracle")` に相談する。これまでの
    失敗試行（何を試して何が起きたか）を渡し、助言を受けて別のアプローチで再試行する
  - 同一goal内の2回目以降のoracle相談は新規ではなく `task(task_id: "<前回のID>")` で同subagent継続として呼ぶ（OmOのresume=session_id相当。文脈を失わず重複説明を省く）
  - **これはrouter gate（diffサイズ）とは別軸のタイミング判断**——無条件で毎回opusを呼ぶのではなく、
    本当に詰まった時だけ上位モデルのコストを払う graph engineering の分岐点
  - stuck 信号は2系統＋fail（いずれかで escalate。eval_cmd 運用では idle の eval 失敗文に自動追記される）:
    - `fail_streak`（連続失敗。`ok`・phase 遷移・resume でリセット。`recordAttempt` 側で判定）
    - 同一ファイル再編集（`stuck_edit_repeat` 既定5連。別ファイル・eval pass でリセット。
      `checkStuck` で判定＝進捗停滞系）
    - diff 停滞（`stuck_diff_stall` 既定4。ワーキングコピー差分が変わらない idle eval の連続。
      差分変化・eval pass でリセット。`checkStuck` で判定＝進捗停滞系）
  - 連続失敗が `max_eval_fails`（既定6）に達すると相談ではなく goal が pause する（giveUp）。修正して resume せよ
- 全タスク実施したら `graphhopper_router_check` を呼ぶ（diffサイズを機械測定してrouteを決める）

### polish

`graphhopper_router_check` の `route` に従う。**simplify は route=polish（大diff）のときだけ
実行**する条件分岐 node（graph engineering）。simplify = 実装は奇麗か / verifier = 要件と合っているか。

#### simplify（route=polish のみ・単体 agent）

- **route=polish（diff > threshold）のときだけ**実行。route=advisor（小diff）はスキップ
- メインが `graphhopper_diff_stash` でdiffを退避（verifierと同一ファイルを共用。再取得しない）
  → 返却pathを渡す（inline 展開は main context を汚すので禁止）
- `task(subagent_type: "graphhopper-simplify")` を**1回**呼ぶ（3レンズ統合の単体 agent）
- **agent は提案者**: findings を `[severity] file:line — 指摘 (suggestion: ...)` で返すだけ。
  **適用はメインが行う**（agent は edit/bash deny）
- **適用ルール**（メイン側）:
  - 各 finding を該当ファイルで Read して裏付け（Iron Law）
  - critical: 挙動不変・局所的なものだけ自動適用（typo / rename / 冗長中間変数削除）。
    interface 変更・signature 変更・新規依存追加は high 扱いで人間に提示
  - high: 人間に確認してから修正
  - medium / note: 報告のみ（恒久記録はしない。graphhopper の goal は verifier clean で完結）
- 適用後は `eval_cmd` を**再実行**して機械確認してから verifier に進む（simplify 後の未検証コードで done を出さない）
- route は simplify 前の記録値に固定。simplify 後に diff を再測定して route を変えない

#### verifier（drift 検出）

`graphhopper_router_check` の `route` に従う。**いずれのrouteでも `graphhopper-verifier` への
第三者チェックは省略できない**（`graphhopper_verifier_set` はresultsが空だとエラーを返す機械ゲートがある。
自己レビューだけでのclean記録は不可能。level/targetの最終決定は機械集約される）:

- **route=advisor**（小diff）: `task(subagent_type: "graphhopper-verifier")` を**1回だけ**、
  `general`charterで呼ぶ。「実装がdesign.mdの意図から外れていないか・テストが実際のユーザーパスを
  検証しているか・変更がgoalに収束しているか、3観点をまとめてレビューせよ」と渡す。
  verifierは変更ファイルに型・lint診断（`npx tsc --noEmit` / `npx pyright` / `npx ruff check`）を実行し、
  findingsの裏付け・反証に使え。LSP照会が使える環境なら診断証拠はlsp_diagnosticsを優先してよい（速い・安い）。
  ただし診断クリーン≠driftなし（挙動driftは診断に出ない）。
  診断が実行不可なら「診断未実行（理由）」を明記し、診断不在をcleanの根拠にしない。
  findingsには証拠状態を必ず付ける（typesafe流・失敗原因分離）: `裏付けあり` /
  `証拠不足` / `診断未実行` / `実行失敗`。原因不明のままlevelだけ付けない
   結果を `graphhopper_verifier_set(results: [{lens: "general", level}], reason: ...)` で記録
   （実行モデルがconfig既定と違う場合は `model` に明示。成績表の帰属に使う）
- **route=polish**（大diff・閾値超）: adversarial verifier fan-out を行う
  1. `task(subagent_type: "graphhopper-verifier")` を3回呼ぶ。それぞれ以下のcharterをプロンプトに含める:
     - requirement: 「実装がdesign.mdの意図から外れていないか（実装漏れ・解釈ズレ・スコープ逸脱）を検証せよ」
     - behavior: 「テストが実際のユーザーパスを検証しているか（モック過多・ハッピーパスのみ・エラー握り潰し）を疑え」
     - progress: 「変更がgoalに収束しているか（堂々巡り・残骸・goal無関係な混入）を見よ」
     時間短縮のため3体は**並列**に投げてよい（MCP駆動では graphhopper_invoke を3連並列。入れ子のみ禁止）。
     charter定型文は MCP prompts（graphhopper-verifier-requirement/behavior/progress）にもある。
     並列時の注意: 各invokeは独立 `opencode run`（自前server＋MCP付きの重い処理）のため、
     同一モデル3連はprovider側rate limitのリトライ待ちになり得る。気になる場合は
     `delayMs` で数秒ずつ起動をずらす。実行中はheartbeatログが出る。キャンセルは子に
     伝播してkillされる（取り消し後の裏回りなし）。
     推奨は3並列＋ずらし（delayMs 0/5000/10000）。直列は遅いだけで安全性は変わらない
- **モデル割当（2026-09-28改定・Bedrock配線後）**: criticは `amazon-bedrock/grok-4.6`
  （Bedrock cross-region `global.xai.grok-4.6`。1回/goalのため約$0.14と誤差。系列多様性も確保）。
  verifierは `claude-oauth/claude-sonnet-5` 維持（判断nodeは品質優先）。
  researcher/librarianは無料枠（researcher=longcat-2.5-preview-freeで試用中、librarian=bunny-free維持で対照）、simplifyはdeepseek-flash、oracleはopus-5を維持。
  注意: session envに陳腐な `AWS_BEARER_TOKEN_BEDROCK` があるとSSOをshadowしてBedrock系が全滅する。
  `graphhopper_invoke` の子には渡さない（invoke.tsで除去済み）。直接 `opencode run` する場合は
  `env -u AWS_BEARER_TOKEN_BEDROCK` を付ける
- **diff肥大は検証コスト3倍**: polish routeは3lensが全差分を読む。748行級は1回で3×748行の
  コンテキスト消費。goalを小さく切ってadvisor（verifier×1）に収めるのが最大の節約。
  巻き戻しはさらに3倍するので、criticで初回品質を上げることも節約になる
   2. `graphhopper_diff_stash` でdiffを/tmpに1回だけ退避し、各verifierには**pathを渡す**
      （inline 3重展開は禁止。3lensが全文を各々読むと3倍燃費になる）。
      読むのは `goal` / `.graphhopper/plans/<goal-id>.md` の内容 / 退避diffの差分範囲＋疑義点のみ。
      behavior charterでは診断証拠（型・lint実行結果）を要求する
  3. drift（乖離）を検出したら**全件報告させる**（閾値カットしない。「重大なものだけ報告」のような保守的指示は書かない——過少報告を招く）
  4. 3体の結果（各charterの level。drift には target 必須）を `results` に詰め、
     `graphhopper_verifier_set(results: [...], reason: ...)` で1回記録する。
     level/target の最終決定は機械集約（いずれか drift → drift、target は
     implementing 優先）であり、メインの裁量で「重大なものだけ採用」といった
     後段フィルタはしない

### done

- `集約 clean` が記録されていれば `graphhopper_phase(phase: "done")` → `graphhopper_goal(action: "complete")`
- self-graded完了は禁止（`graphhopper_goal(complete)` は直近verifierがcleanでないとエラーを返す）

## handoff（別セッションへの引き継ぎ）

- 会話が大きくなった等、必要に応じて明示的に `graphhopper_handoff(session_id: "<ID>")` を呼ぶ
  （`session_id`未指定なら候補セッション列挙のみ、送信しない）。信頼できるセッション
  同士でのみ使う（opencodeにはClaude Codeの`crossSessionInbound`相当の受信制御が無く、
  受け手は許可なしで自動処理するため）
- 受け手は `graphhopper_resume` → `graphhopper_status` で引き継ぐ

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
