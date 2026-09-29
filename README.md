# graphhopper-opencode

**graphhopper for opencode** — designing/implementing/polish state machine plugin。

元は Claude Code plugin として作られた [graphhopper](../graphhopper) を、
[opencode](https://opencode.ai/) plugin として再設計した版。flywheel-opencode の
atomic write パターン（`src/state.ts`）・agent注入パターン（`src/agents.ts`）を参考にしつつ、
ゼロから実装している。

## graphhopper本体との対応・最大の違い

graphhopper本体（Claude Code版）はshell hook（`hooks/design-gate.sh` / `hooks/loop-driver.sh`）で
designing中のsource編集を物理ブロックし、diffサイズでadvisor/polishに分岐する。opencodeには
Claude Codeのshell hook（PreToolUse/Stop）に相当する仕組みが無いため、plugin本体（TS）で
同じ強制力を作る:

| Claude Code | opencode | 実装 |
|---|---|---|
| `PreToolUse`（design-gate.sh の物理ブロック） | `tool.execute.before` | `src/index.ts` の design gate |
| `Stop`（loop-driver.sh の router gate） | `event: session.idle` | `src/index.ts` の continuation |
| `eval_cmd`（`bin/graphhopper set-eval`、Stop hookで機械実行） | `graphhopper_set_eval` + `session.idle` で機械実行 | `src/state.ts` の `runEval` / `src/index.ts` の `session.idle` |
| `Workflow`（agent()+parallel()のインラインJS） | 無し | fan-outは skill が `task()` を手動で複数回呼ぶ + `graphhopper_discover_tick` 等のTS toolでround cap/dedupeを強制 |
| design.md不変化（designing終了後の事後編集ブロック） | `tool.execute.before` の追加チェック | `state.isDesignDocLocked` |
| `design-set`（design.md質レビューのopt-in記録） | `graphhopper_critic_set` | `state.setCriticVerdict`（`graphhopper-critic`は本移植では元々常設nodeなので、記録機構だけの追加） |

**flywheel-opencodeとの違い**: flywheel-opencodeは`tool.execute.before`を一切使っていない
（continuationTextで指示するだけで、実際にEdit/Writeを拒否する強制力が無い）。graphhopper-opencodeは
これを追加し、C-2不変条件（designing中はsource編集を物理ブロック）をコード側で担保する。

## 構成

```
graphhopper-opencode/
├── src/
│   ├── index.ts   — プラグイン本体（tool.execute.before + event + 18 tool）
│   ├── state.ts   — .graphhopper/ 配下の state 管理（atomic write）
│   ├── gate.ts    — helper・定数の単一源泉（entryは関数exportのみの制約対応）
│   ├── mcp.ts     — MCPブリッジ（20 tool＋resources/prompts。API経由セッション用）
│   ├── agents.ts  — 8 subagent 定義（config hook で注入。入口トリアージ用graphhopper-jev・相談判定用graphhopper-advisor含む）
│   ├── prompts.ts — MCP prompts charter定型文の単一源泉（8件）
│   ├── invoke.ts  — graphhopper_invoke（opencode run spawn・中断伝播・heartbeat）
│   ├── watch.ts   — outbox監視（--notifyでmacOS通知）
│   ├── hashedit.ts — hash検証付きeditの純粋関数
│   ├── ponytail-rules.ts — ponytailルール本文（vendored）
│   └── lsp/       — LSP transplant（diagnostics/hover/definition等の照会）
├── skills/
│   ├── graphhopper/ — メインのdesigning/implementing/polishループ
│   └── discover/    — loop-until-dry 探索（phase graphの外、オンデマンド）
├── commands/
│   ├── graphhopper.md
│   ├── graphhopper-status.md
│   ├── graphhopper-stop.md
│   └── graphhopper-resume.md
├── package.json
└── tsconfig.json
```

## 提供するツール

| ツール | 用途 |
|---|---|
| `graphhopper_goal` | goal の start/pause/resume/complete/clear |
| `graphhopper_status` | 現在 goal + フェーズ + router + verifier 表示 |
| `graphhopper_phase` | フェーズ遷移（designing → implementing → polish → done） |
| `graphhopper_router_check` | diffサイズを機械測定し advisor(verifier×1)/polish(verifier×3) に分岐（loop-driver.sh相当） |
| `graphhopper_diff_stash` | verifier fan-out用にdiffを.graphhopper/tmpへ1回だけ退避しpathを返す（3 lensへのinline 3重展開防止） |
| `graphhopper_route` / `graphhopper_route_set` | jev入口トリアージ。判定prompt発行＋記録（full/light/direct/advised/oracle。旧A/B/Cも受理。不正値はfullに倒す。directはhistory 1行のみ） |
| `graphhopper_escalate` | light/advised→full昇格（designing巻き戻し＋critic1回＋fan-out×3。full→light禁止のラチェット） |
| `graphhopper_verifier_set` | verifier結果を記録。各charterの結果をresultsに詰めるとlevel/targetは機械集約（state.aggregateVerdicts）される。resultsが空だとエラーになる（self-graded完了防止の機械ゲート） |
| `graphhopper_set_eval` | implementingの合否判定コマンド（本体のeval_cmd相当）を設定。設定後はターン終了ごと自動実行され、pass=polish自動遷移／fail=fail_streak機械カウント |
| `graphhopper_attempt` | 実装試行の成否を記録（eval_cmd未設定時の自己申告フォールバック。連続失敗でescalate→oracle相談） |
| `graphhopper_eval` | eval_cmdを明示実行（MCPのみ。pluginはsession.idleで自動実行） |
| `graphhopper_hash` / `graphhopper_edit` | hash検証付きedit（goal中のsource編集用。read→sha1検証→単一箇所exact-match） |
| `graphhopper_scoreboard` | モデル別verdict集計＋goal転帰＋hints（評価機能の成績表） |
| `graphhopper_discover_start` / `_tick` / `_clear` | loop-until-dry 探索（round cap/dedupeをtool側で強制） |
| `graphhopper_critic_set` | designing終了前のdesign.md質レビュー結果（clean/drift）を記録する。opt-in・ハードゲート無し（`graphhopper_phase`の前提条件にはしない） |
| `graphhopper_handoff` | 現在の goal 状態を要約して別の opencode セッションへ引き継ぎ送信。送信後は送信側が goal から解放（pause + unbind）。`session_id` 未指定なら候補セッションを列挙（送信しない）。受け手は `graphhopper_resume` で引き継ぐ |

## 提供する subagent

| subagent | phase | 対象artifact | 用途 | tier |
|---|---|---|---|---|
| `graphhopper-researcher` | 任意 | コードベース/外部doc | 事実収集・調査専用。高頻度なので最安モデル | 最下層コスト |
| `graphhopper-jev` | goal開始前 | やる内容テキスト | 入口トリアージ（route 5択の1行JSON判定。ollaya型typed choice相当） | 最下層コスト |
| `graphhopper-advisor` | 任意 | 問い・判定材料テキスト | selector判定・セカンドオピニオン（stuck時はoracle。出力は非拘束） | 最下層コスト |
| `graphhopper-critic` | designing（実装前・pre-hoc） | design.md（計画） | 敵対レビュー（要件漏れ・設計の穴・スコープ逸脱） | 上位品質・別ベンダー推奨 |
| `graphhopper-oracle` | implementing（詰まった時。`graphhopper_attempt`のfail_streakがstuck_threshold到達） | 失敗試行の文脈 | 手詰まり打開の相談役 | 上位品質 |
| `graphhopper-simplify` | polish（実装後・post-hoc。大diffのみ） | コードdiff | simplify提案（3レンズ: 再利用・品質・効率） | 中位 |
| `graphhopper-verifier` | polish（実装後・post-hoc） | コードdiff | adversarial verifier fan-out。判断node | 上位品質 |

`graphhopper-critic`（pre-hoc）と`graphhopper-verifier`（post-hoc）はどちらも「敵対的レビュー」だが、
対象artifactが違う（計画テキスト vs 実装diff）。phaseは単一のstate変数でdesigning完了後にしか
implementingへ進めないため、両者が同時に走ることはなく、役割の重なりによる曖昧さは無い。

graphhopper本体のtiering（researcher=haiku, main=sonnet, advisor/verifier=opus）をそのまま踏襲。
vendorは増やさない（judgment分散はレンズの違いで確保し、council再発防止の原則を守る。ただしcriticは
実装前の計画検証という役割上、設計段階の系列多様性を得るために別ベンダー推奨）。
具体モデルは公開リポジトリにハードコードせず、`.graphhopper/config.json` の `agents.<name>` で
プロジェクト単位に指定する（未指定時はセッションのメインモデルを継承）。

`.graphhopper/config.example.json` が設定の雛形（モデル上書き・router閾値・design gate パス等）。
実際に使うにはコピーする:
```bash
cp .graphhopper/config.example.json .graphhopper/config.json
```
`config.json` は `.gitignore` 対象なので、ローカル固有の設定・認証情報を入れても公開されない
（`.gitignore` は `.graphhopper/*` を無視した上で `config.example.json` だけを明示的に例外化する
allowlist方式。`.graphhopper/` 配下に新規ファイルを追加する場合、config.example.json 以外は
自動的に無視される）。

### 2つの上位モデル起動軸

router gate（diffサイズ）とstuck escalation（詰まった回数）は独立した分岐点:

| 軸 | トリガー | 発生phase | 呼ばれるagent | 目的 |
|---|---|---|---|---|
| router gate | `graphhopper_router_check` がdiff行数を機械測定 | polish | `graphhopper-verifier` ×1(advisor,general charter)/×3(polish fan-out) | done-gate前のdrift検証 |
| stuck escalation | `graphhopper_attempt` の連続失敗が`stuck_threshold`（既定3）到達 | implementing | `graphhopper-oracle` ×1 | implementing中の手詰まり打開 |

phaseは単一のstate変数なので、この2軸は排他的に発生する（implementing中はstuck escalationのみ、
polish中はrouter gateのみが起こり得る）。合流点の優先順位を定義する必要は無い。

router gate側は**advisorでも第三者チェックそのものは省略できない**（`graphhopper_verifier_set`が
lens空を拒否するため、diffサイズに関わらず最低1回のverifier呼び出しが機械的に必須。self-graded
完了を防ぐ）。fan-out数（1 or 3）だけがdiffサイズで変わる。

いずれも「無条件で毎回opusを呼ぶ」のではなく、コード側で機械測定・機械カウントした
タイミングでだけ上位モデルのコストを払う設計。

## ponytail 統合（implementing フェーズ限定）

[ponytail](https://github.com/DietrichGebert/ponytail)（怠惰なシニアデベロッパー / YAGNI）のルールを
**implementing フェーズ中のみ・メインセッションのみ**に注入する。

- グローバルの ponytail プラグイン（全ターン常時注入 ~1,400 トークン）は使わず、
  graphhopper の `experimental.chat.system.transform` フック内で `.graphhopper/state.json` の
  `phase === "implementing"` かつ `session_id === 当該セッション` のときだけ注入する。
- ルール本文は `src/ponytail-rules.ts` に vendored（ディスティル版 ~900–1,200 トークン（CJK 混在・実測）、
  `@dietrichgebert/ponytail@4.9.0` の SKILL.md 由来、MIT）。
- designing 中は「書くな」圧をかけない。polish は `graphhopper-simplify` が担当。
- 注意: `graphhopper_phase(implementing)` を呼ぶターン自体には注入されず、次ターンから有効。
  逆も同様で、`graphhopper_phase(polish)` を呼ぶターンは phase がまだ implementing のため注入されたまま
  （prompt-time ゲートの構造的必然。影響は遷移ターンの1回のみ）。
- 節約: 同一(session, goal)の2回目以降は短縮1行のみ注入（初回full→以降brief。hard制約は
  コード側ゲートのため安全性不変。再起動・compact後はfull再送）。

## handoff（別セッションへの引き継ぎ）

`graphhopper_handoff` は現在の goal 状態を別の opencode セッションへ `promptAsync` で送る
（Claude Code の cross-session messaging 相当）。送信後は送信側が goal から解放される（pause + unbind）。

**注意**: opencode には Claude Code の `crossSessionInbound: hold/refuse` に相当する**受信制御がない**。
実測では、`promptAsync` で注入された指示は受け手エージェントが**許可なしでツール実行まで自動処理**する。
そのため handoff は**信頼できるセッション同士でのみ**使い、`session_id` は明示指定すること。
勝手に自動送信はしない設計（明示呼び出しのみ）。受け手は「handoff received」応答で受領を示し、
`graphhopper_resume` で引き継ぐ。

## MCP ブリッジ（API 経由セッション用）

plugin tool は opencode ランタイム内のセッションにしか配膳されず、API 経由の
セッション（`default.*` toolset）には届かない。MCP だけが両方に届く実証済みの道のため、
`src/mcp.ts` が state 操作を MCP tool（stdio）として公開する:

- plugin と同名・同-semantics の 20 tool（`graphhopper_handoff` は opencode SDK client が必要なため対象外。
  代わりにMCPのみの `graphhopper_eval`・`graphhopper_invoke`・`graphhopper_scoreboard` を含む）
- `root`（対象プロジェクト）・`session_id`（bind 先）を明示指定する。
  MCP には `session.idle` 駆動が無いため、`graphhopper_set_eval` 後に
  `graphhopper_eval` で明示実行する（遷移ルールは plugin の idle eval 経路と同型）
- 指示文は `src/gate.ts` の `PHASE_ACTION` が単一源泉（plugin/MCP 共通）

`~/.config/opencode/opencode.json` の `mcp` に登録:

```json
{
  "graphhopper": {
    "type": "local",
    "command": ["<mise-shims>/bun", "<repo>/src/mcp.ts"],
    "enabled": true
  }
}
```

制約: opencode の plugin loader は entry module の全 export 値を走査し、
関数でない値が1つでもあると `Plugin export is not a function` で load 全体が
失敗する。そのため `src/index.ts`（entry）は plugin 関数 `Graphhopper` のみを
export し、helper・定数は `src/gate.ts` に置く。entry に非関数 export を足すと
plugin が黙って消える（`~/.local/share/opencode/log/opencode.log` に ERROR）。

### MCP resources（参照系）

tool 呼び出しより安い読み取り用。URI 形式は
`graphhopper://graphhopper/<encodeURIComponent(root)>/<rel>`:

| rel | 内容 |
|---|---|
| `state.json` | 現在のループ状態 |
| `goals.json` | 目標キュー＋active指定 |
| `history.jsonl` | 監査ログ（末尾200行に丸め） |
| `plans/<goalId>.md` / `plans/<goalId>.log.md` | design doc・log |
| `lineage.json` | goalごとの系譜（phase遷移・verifier・巻き戻し・編集ファイル＋graft symbol・designタスク進捗。作業グラフのedge素材。仮想resource） |

`ListResources` は空（root が呼出側依存で列挙不能）、templates 5件で発見可能にする。
rel は allowlist＋containment 検査で traversal を拒否する。

### MCP prompts（charter定型文・8件）

reviewer/調査役の charter を prompts として公開。TUI の `task(subagent_type: ...)` と
文面を合わせ、MCP駆動では `graphhopper_invoke` の prompt にそのまま載せる:

| prompt | 用途 |
|---|---|
| `graphhopper-critic` | design.md敵対レビュー（design docを埋め込み返却） |
| `graphhopper-verifier-requirement` / `-behavior` / `-progress` | polish fan-out各lens（3連並列可） |
| `graphhopper-verifier-general` | advisor route用統合charter |
| `graphhopper-oracle` | 手詰まり相談（直近の失敗記録を埋め込み返却） |
| `graphhopper-researcher` / `graphhopper-librarian` | 内外調査（query必須） |

critic/verifier系には言語版ガード（PEP 758 等の誤検知止め）を同梱。
`src/prompts.ts` が単一源泉（SKILL.md の同名ルールと一対で維持する）。

### MCP 仕上げ（roots・annotations・logging）

- `root` 省略時は client roots の先頭（file://）→プロセス cwd の順で解決する
- tool annotations: `status`/`hash` は readOnly、`edit` は destructive、
  `eval`/`invoke`/`router_check` は openWorld の hint を付与
- 全20 tool が `outputSchema`＋`structuredContent` を返す（text 応答は不変）
- tool 実行後に logging 通知を転送（state 遷移系は info、それ以外は debug）。
  client 未対応でも tool 結果は壊さない

### program-side flow（prose→code）
会話上の規律だったものを機械に寄せたもの（taktのworkflow doctorの発想）：

- **遷移合法性**：designing→implementing→polish→done のみ（polish→implementing巻き戻し可）。
  `setPhase(done)` 直指定は拒否（doneはverifier clean後のcompleteのみ。self-graded doneの穴塞ぎ）
- **critic gate**：`require_critic: true` で designing→implementing に critic 記録を要求。
  既定 false（opt-in維持。ゲート化の是非未決のためflag両対応）
- **attempt一本化**：eval_cmd設定中のattempt(fail)には二重計数の注意を付与（拒否ではなく注意）
- **単一driver警告**：bind中goalへの別session操作に警告（拒否ではなく警告。handoff正規フローのため）
- **discover紐付け**：開始時点のactive goalを記録し、lineageに載せる

### design scaffold＋構造ゲート

- `goal(start)`時に`plans/<goal-id>.md`の骨格を自動生成（goal理解／現状／設計判断／
  タスク列／棄却表＋タスク行）。既存ファイルは壊さない（冪等）
- `designing→implementing`遷移時に骨格の有無を機械チェック。不足があれば遷移拒否
  （質は見ない。質の厳格化は「薄く書いて回避する」エロージョンを再生産するため。
  質はcriticの領分）
- 検証キーワードは既存doc実態に較正（テンプレ準拠docは通過、スタブは検出）
- designタスク列（`- [ ]`）は抽出してlineageの`tasks`に載せる（progress lens素材）

### outbox＋watch（durable通知）

会話上の「終わったよ」ではなくプログラムが受け取れる通知：

- `recordEvent` が curated種別（goal_complete / verifier_verdict / eval_gave_up /
  loop_stopped）を `.graphhopper/outbox/<時刻>-<種別>-<goal>.json` に投下（上限100・古いものから刈る）
- `bun src/watch.ts <root> -- <command>` で監視し、イベントごとにコマンド実行
  （`GH_EVENT` / `GH_GOAL` / `GH_FILE` / `GH_ROOT` を環境変数で渡す）
- `bun src/watch.ts <root> --notify` でmacOS通知プリセット
  （goal_complete［score付き］/ eval_gave_up / loop_stopped。driftは正常フローのため対象外）。
  `--notify -- <command>` で併用可
- MCP logging は live補助線として継続（best-effort）。durable が outbox、live が logging の二層

### 評価機能（成績表／採点）

- **モデル×役割の成績表**：verdict/critic記録に実行モデルを記録（省略時はconfig既定で補完）。
  `graphhopper_scoreboard` でモデル別 verdict 集計（clean/drift）とgoal転帰
  （巻き戻し・eval・採点）を返す。マッピング判断の素材。
  注意：導入前のhistory分は現configで補完されるため帰属が不正確な場合がある（今後の記録から正確化）
- scoreboardには`hints`が付く（提案のみ・自動適用なし）。
  ガード付き：モデル別は5件未満で判断保留、drift検出率≧60%・全clean継続・score<70・
  巻き戻し≧2を人手検討事項として挙げる。drift率の高低は厳格さと実装荒れの両義性があるため断定しない
- **B goal出来栄えの機械採点**：complete時に機械事実のみで採点しgoalに保存。
  式v1: `100 - 15*巻き戻し - 5*最大fail - 3*gate阻止 - 5*(verifier追加round)`（下限0）。
  内訳付きで透明化。status/lineage/scoreboardに表示

### グラフ化の方向性（作業グラフ × コードグラフ）

- `lineage.json`：goals＋history から goal 系譜を導出する仮想 resource。
  各 goal の編集ファイルには graft skeleton の symbol 一覧（`editedSymbols`）を
  lazy enrich する（best-effort：graft不在・timeoutでも空配列に倒す。edit 経路は
  触らない）。「どの goal がどの symbol に触ったか」が引ける
- 次は stuck 検知の symbol レベル化（同一 symbol 再編集の計数）。未着手

### MCP 構造化出力・elicitation

- 主要 tool（goal/status/phase/set_eval/eval/attempt/router_check/diff_stash/verifier_set等）は
  `outputSchema`＋`structuredContent` を返す（text 応答は不変。CI・watchdog向け）
- `complete` の verifier ガード・`resume` の loop-stop ブロックは elicitation で
  構造化承認を求める。client 未対応・拒否時は従来の error 文にフォールバックする
  （`force: true` の明示指定も従来通り有効）

### MCP駆動での reviewer 役割（invoke）

API 経由セッションの `task` には opencode 側 subagent（critic/verifier/oracle 等）が
配膳されない（harness の固定リストのため）。代わりに `graphhopper_invoke` を使う:
`opencode run --model --agent --dir` を subprocess として spawn し、別モデルの
一発回答を stdout で返す。入れ子禁止・prompt 12000字・timeout 既定120秒。
MCP駆動ループでは critic/verifier/oracle の呼び出しをすべて invoke に読み替える
（応答文中の `task(subagent_type: ...)` は TUI 用の表記）。

### invoke並列安全（中断伝播・heartbeat・ずらし）

verifier fan-out等の並列投げで固まって見えた事故（2026-09-24: 同一モデル3連の
rate limitリトライ待ち＋無出力＋キャンセル不伝播）の対策：

- **中断伝播**：MCP clientのキャンセルを子プロセス群に伝播しkillする。
  取り消し後に裏で回り続ける事故を塞ぐ（`cancelled` で報告）
- **heartbeat**：実行中30秒ごとにMCP loggingへ生存通知。「固まり」知覚を防ぐ
- **delayMs**：起動ずらし（herd回避・opt-in、既定0で完全並列維持）
- grace期間（SIGTERM→SIGKILL）は設定化（既定5秒）

## state の場所

```
.graphhopper/
├── goals.json      — 目標キュー + active 指定
├── state.json      — 現在のループ状態（goal / phase / router / verifier）
├── config.json     — プロジェクト毎の上書き設定（任意）
├── history.jsonl   — 監査ログ（append-only）
├── discover.json   — discoverセッションの一時state（round/seen/confirmed）
└── plans/
    ├── <goal-id>.md      — design ドキュメント（designingフェーズで書く唯一の許可パス。
    │                        designing終了後は`tool.execute.before`が事後編集を物理ブロックする
    │                        ——verifierのdrift検出アンカーを守るため、不変）
    └── <goal-id>.log.md — 決定の経緯・棄却した代替案・進捗（design.mdとは別物、追記専用・
                             ハードゲート無し、全phaseで自由に書ける。handoff先が読む想定）
```

## インストール

```bash
# <repo> はこのリポジトリの checkout 先（例: ~/work/graphhopper-opencode）
ln -s <repo>/src/index.ts ~/.config/opencode/plugins/graphhopper.ts
ln -s <repo>/skills/graphhopper ~/.config/opencode/skills/graphhopper
ln -s <repo>/skills/discover ~/.config/opencode/skills/graphhopper-discover
mkdir -p ~/.config/opencode/commands
for f in <repo>/commands/*.md; do
  ln -sf "$f" ~/.config/opencode/commands/$(basename "$f")
done
```

`~/.config/opencode/opencode.jsonc` に plugin 登録:

```jsonc
{
  "plugins": ["./plugins/graphhopper.ts"]
}
```

## verify

```bash
npx tsc --noEmit
```
