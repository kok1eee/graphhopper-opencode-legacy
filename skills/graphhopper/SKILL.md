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
| 気軽な相談 | `graphhopper-advisor` | セカンドオピニオン・advised入口の相談。stuck時はoracle（advisorで代替しない）。出力は非拘束。selector判定はd1 tool（`graphhopper_selector`）に移管 |
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

### 入口トリアージ（decide・route full/light/direct/advised/oracle）

フルループが大袈裟な作業に相応の重さで回す入口判定。判定は `graphhopper_decide`
（d1 decision-modelのChoice型でroute 5択＋confidence。低confidence・障害時はfull。`LIQUID_API_KEY` が要る）:

- `graphhopper_route(request)` → 手順取得 → `graphhopper_decide(request)` で判定 →
  `graphhopper_route_set(route, reason)` で記録。
  decide/selectorの呼び出しは `.graphhopper/decisions.jsonl` に自動記録される
  （route・confidence・レイテンシ。閾値較正の材料にするため入口では必ず呼ぶこと）
- **full=フル**（現行通り）/**light=軽量**（thin design＋task列のみ、critic省略、verifier general×1）/
  **direct=直行**（loopなし・goalを作らない。historyに1行のみ残る）/
  **advised=軽量＋第二意見**（light相当＋implementing前にadvisor相談1回）/
  **oracle=多角**（full相当＋開始時にoracle相談1回。stuck時は同session継続）
- parse失敗・範囲外・未呼び出しは**fullに倒す**（fail-safe。state null＝full）。
  旧A/B/Cも受理しfull/light/directに写像する
- **昇格のみ可**（full→light禁止のラチェット）。stuck発火時は `graphhopper_escalate`、
  `router_check` でlight/advised＋大diffなら**自動昇格**（designing巻き戻し＋肉付け＋critic1回＋fan-out×3）。
  stuck発火時もlight/advisedは自動昇格する（fullのstuckは従来通りoracle相談）。
  昇格後はcritic記録なしにimplementingへ進めない（機械ゲート）
- light適用条件（decide criteria）：単一関心・設計判断なし・既存踏襲・テスト容易。
  1つでも欠けたらfull。誤lightは昇格で回収する前提

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
> 詳細は [refs/implementing.md](refs/implementing.md) を読め（implementingに入ったら必読）

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

> selectorの詳細は [refs/verifier.md](refs/verifier.md) を読め（polishに入ったら必読）
> 詳細は [refs/verifier.md](refs/verifier.md) を読め（polishに入ったら必読）

### done

- `集約 clean` が記録されていれば `graphhopper_phase(phase: "done")` → `graphhopper_goal(action: "complete")`
- self-graded完了は禁止（`graphhopper_goal(complete)` は直近verifierがcleanでないとエラーを返す）

## handoff（別セッションへの引き継ぎ）

- 会話が大きくなった等、必要に応じて明示的に `graphhopper_handoff(session_id: "<ID>")` を呼ぶ
  （`session_id`未指定なら候補セッション列挙のみ、送信しない）。信頼できるセッション
  同士でのみ使う（opencodeにはClaude Codeの`crossSessionInbound`相当の受信制御が無く、
  受け手は許可なしで自動処理するため）
- 受け手は `graphhopper_resume` → `graphhopper_status` で引き継ぐ

## compact運用（handoffの代替・推奨）

別セッションを作らず `/compact` で回す場合、handoffは不要。compactは同一セッションの
圧縮でありsessionIDは維持されるため、goalのbindは継続する。復帰手順:

1. `graphhopper_status` でgoal・phase・router・verifierを確認する
2. `.graphhopper/plans/<goal-id>.md`（design）と`.log.md`（決定経緯・進捗）を読み直す
3. そのまま続行する（bindし直し不要。`unbound`と出たら`resume`でbindし直す）

compact前に `.log.md` へ決定事項・途中経過を書いておくこと（圧縮要約に落とせない詳細の保全。
state・design・historyはdiskにあり圧縮の影響を受けない）。

> 詳細は [refs/gotchas.md](refs/gotchas.md) を読め（該当時に参照）

