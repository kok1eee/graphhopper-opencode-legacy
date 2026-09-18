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
│   ├── index.ts   — プラグイン本体（tool.execute.before + event + 8 tool）
│   ├── state.ts   — .graphhopper/ 配下の state 管理（atomic write）
│   └── agents.ts  — 2 subagent 定義（config hook で注入）
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
| `graphhopper_verifier_set` | verifier結果を記録。各charterの結果をresultsに詰めるとlevel/targetは機械集約（state.aggregateVerdicts）される。resultsが空だとエラーになる（self-graded完了防止の機械ゲート） |
| `graphhopper_set_eval` | implementingの合否判定コマンド（本体のeval_cmd相当）を設定。設定後はターン終了ごと自動実行され、pass=polish自動遷移／fail=fail_streak機械カウント |
| `graphhopper_discover_start` / `_tick` / `_clear` | loop-until-dry 探索（round cap/dedupeをtool側で強制） |
| `graphhopper_critic_set` | designing終了前のdesign.md質レビュー結果（clean/drift）を記録する。opt-in・ハードゲート無し（`graphhopper_phase`の前提条件にはしない） |
| `graphhopper_handoff` | 現在の goal 状態を要約して別の opencode セッションへ引き継ぎ送信。送信後は送信側が goal から解放（pause + unbind）。`session_id` 未指定なら候補セッションを列挙（送信しない）。受け手は `graphhopper_resume` で引き継ぐ |

## 提供する subagent

| subagent | phase | 対象artifact | 用途 | tier |
|---|---|---|---|---|
| `graphhopper-researcher` | 任意 | コードベース/外部doc | 事実収集・調査専用。高頻度なので最安モデル | 最下層コスト |
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

- plugin と同名・同-semantics の 13 tool（`graphhopper_goal`〜`graphhopper_edit`。
  `graphhopper_handoff` は opencode SDK client が必要なため対象外）
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

`ListResources` は空（root が呼出側依存で列挙不能）、templates 4件で発見可能にする。
rel は allowlist＋containment 検査で traversal を拒否する。

### MCP 構造化出力・elicitation

- 主要 8 tool（goal/status/phase/set_eval/eval/attempt/router_check/verifier_set）は
  `outputSchema`＋`structuredContent` を返す（text 応答は不変。CI・watchdog向け）
- `complete` の verifier ガード・`resume` の loop-stop ブロックは elicitation で
  構造化承認を求める。client 未対応・拒否時は従来の error 文にフォールバックする
  （`force: true` の明示指定も従来通り有効）

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
ln -s ~/masayoshi/graphhopper-opencode/src/index.ts ~/.config/opencode/plugins/graphhopper.ts
ln -s ~/masayoshi/graphhopper-opencode/skills/graphhopper ~/.config/opencode/skills/graphhopper
ln -s ~/masayoshi/graphhopper-opencode/skills/discover ~/.config/opencode/skills/graphhopper-discover
mkdir -p ~/.config/opencode/commands
for f in ~/masayoshi/graphhopper-opencode/commands/*.md; do
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
