/**
 * graphhopper の専用 subagent 定義（config hook で注入）
 *
 * graphhopper本体（Claude Code版）のtiering をそのまま踏襲する:
 *   researcher = 最下層コスト・高速（高頻度・事実収集専用・判断を含まない）
 *   verifier(polish) / oracle(stuck escalation) = 上位品質（判断node、常に最高品質を保証）
 *
 * oracleはpolishのdiffサイズ分岐（router gate）とは別軸のタイミング判断:
 * 「詰まった回数」（graphhopper_attemptのfail_streak）がstuck_thresholdに達したら
 * 呼ぶ、というgraph engineeringの分岐点。無条件で毎回上位モデルを呼ぶのではなく、
 * 本当に必要な時（手詰まり）にだけ上位モデルのコストを払う。
 *
 * 2026-08-06: モデル指定を公開リポジトリから除去し、プロジェクト単位の
 * `.graphhopper/config.json` の `agents` で上書きする方針に変更。
 * 既定（model 未指定）は opencode のセッションメインモデルを継承する。
 * 以前は amazon-bedrock（Claude ファミリ）を既定にしていたが、bedrock の
 * AWS_BEARER_TOKEN_BEDROCK が壊れて認証が通らず verifier 等が空応答を返すため、
 * 公開リポジトリにモデル選択を持たせない運用にした。tier 思想（researcher=最下層
 * / verifier・oracle=上位品質）はそのまま、具体モデルは各プロジェクトで選ぶ。
 * 系列多様性の議論（flywheelの2-vendor構成）はgraphhopperの**判断node**には不要——
 * 判断は「メイン + verifier」の2層で足りるというgraphhopper自体の設計原則
 * （council再発防止）に合わせ、判断系でvendorを増やさない。
 * ただし設計段階の質チェックnode `graphhopper-critic` は実装前の計画検証で、
 * メインとは別ベンダー（例: Luna）を使うことで系列多様性を設計段階で得る
 * （verifier=実装後のdrift検出 / critic=実装前の計画検証 の役割分担）。
 *
 * 全て読み取り専用（edit deny + bash は `rg` / `fd` のみ許可）。実装はメインループ側だけが行う。
 * ユーザーが opencode.json(c) に同名 agent を定義している場合はそちらを優先する。
 * プロジェクト単位のモデル上書きは .graphhopper/config.json の agents で指定する。
 */
import { readConfig } from "./state";
import type { Config } from "@opencode-ai/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";

/**
 * 全subagent共通の探索ルール（graft-first）。
 * 背景: researcher/critic/verifier が Grep ツール連打・graft MCP 未使用で
 * トークンを浪費する事例が多発したため、prompt レベルで強制する。
 * tier: graft（意味・構造の入口）→ ast-grep（構造パターン）→ rg（テキスト最終手段）。
 *   tgrep は表現力が rg と同じで利点が「巨大repoでの速度」だけであり、index/serve を
 *   deny している（BYOS）以上・通常repoでは rg と等価で判定ノイズになるため tier から外した。
 *   逃走経路として SKILL.md の Gotchas にのみ記載し、allowlist には `tgrep search*` を残す
 *   （design g-mu4wradt D4 の事後改訂）。
 * - テキスト検索は plain grep ではなく必ず `rg`（bash経由）。
 * - 同じ概念の検索を繰り返さない。Read 全文取得の直後に同じファイルへ Grep しない。
 */
const SEARCH_RULES: readonly string[] = [
  "- コード探索は graft MCP を先に使う（graft_find_code=定義・意味検索 / graft_find_all=全出現 / graft_trace_calls=呼び出し元・先と blast radius / graft_file_api=ファイルのAPI一覧 / graft_repo_map=未踏リポジトリの把握）。graft で絞りきれない場合だけ ast-grep にフォールバックする",
  "- file＋line（col任意）が手元にある場合のみLSP点照会（lsp_hover/lsp_goto_definition/lsp_find_references/lsp_document_symbols/lsp_diagnostics）を先に使う。symbol名のみ・『どこにあるか』自体が問いならgraft-firstを維持する。graftの絞り込み前にlsp_workspace_symbolsを投げない",
  "- 構造パターン検索は `ast-grep` を使う（例: `ast-grep -p 'function $NAME($$$)' <path>`、YAMLルールは `ast-grep --rule rule.yaml`）。`sg` はLinuxで newgrp を指すため使わない",
  "- テキスト検索は最終手段として `rg` を使う（例: `rg -n <pattern> <path>`）。plain grep は使わない。同じ概念の検索を繰り返さない",
  "- ファイル名・ディレクトリ探索は `fd` を使う（例: `fd --type f <name> <path>`、`fd --max-depth 2 --type d <name>`）。単純なパターン一致は Glob ツールでも可。`find` は使わない",
  "- Read で全文取得した直後に同じファイルへ Grep しない（全文が手元にある）",
];

/**
 * 読み取り専用を保ったまま検索・確認系コマンドだけ許可する bash 権限（design g-mtwlqzbb）。
 * 全subagentは edit deny + bash はこの許可リストのみ（plain grep・find 等の他コマンドは deny）。
 *
 * 重要: opencodeのbash permissionはfindLast（最後にマッチしたルールが勝つ）で評価される。
 * このオブジェクトの記述順がそのまま評価優先度になるため、以下の構造を厳守すること:
 *   1. base deny（"*": "deny"）— 先頭
 *   2. 個別allow群 — 中盤
 *   3. リダイレクト・引数注入対策のdeny群 — 必ずallow群より後方（末尾）
 * 将来コマンドを追記する際、allow行を末尾に追加すると3のdeny群より後に来てしまい、
 * リダイレクト対策が静かに無効化される。追記は必ず2の位置（deny群より前）に行うこと。
 */
export const SEARCH_ONLY_BASH: Record<string, "allow" | "deny" | "ask"> = {
  "*": "deny",
  // 1. 個別allow群（検索・確認系のみ。書き込み・外部実行系オプションを持つコマンドは
  // 引数注入対策(下記3)と対で追加する）
  rg: "allow",
  "rg *": "allow",
  fd: "allow",
  "fd *": "allow",
  "tgrep search*": "allow", // 逃走経路（巨大repoのみ・SKILL.md Gotchas参照）。index/serveは状態変更のためdeny
  cat: "allow",
  "cat *": "allow",
  head: "allow",
  "head *": "allow",
  tail: "allow",
  "tail *": "allow",
  "wc *": "allow",
  pwd: "allow",
  ls: "allow",
  "ls *": "allow",
  "git status": "allow",
  "git status *": "allow",
  "git diff": "allow",
  "git diff *": "allow",
  "git log": "allow",
  "git log *": "allow",
  "jj status": "allow",
  "jj status *": "allow",
  "jj diff": "allow",
  "jj diff *": "allow",
  "jj log": "allow",
  "jj log *": "allow",
  pyright: "allow",
  "pyright *": "allow",
  "ruff check": "allow",
  "ruff check *": "allow",
  "tsc --noEmit": "allow",
  "tsc --noEmit *": "allow",
  // 構造検索は canonical 名の `ast-grep` のみ許可する。`sg` は macOS では ast-grep の
  // deprecated shim だが、Linux（Amazon Linux 等）では newgrp への symlink であり
  // 「別グループでの任意コマンド実行」になる。機械依存の穴を作らないため sg は deny（下記）。
  "ast-grep": "allow",
  "ast-grep *": "allow",
  "npx tsc --noEmit": "allow",
  "npx tsc --noEmit *": "allow",
  "npx pyright": "allow",
  "npx pyright *": "allow",
  "npx ruff check": "allow",
  "npx ruff check *": "allow",
  // 2. リダイレクト対策（allow群より後方。空白ありの `>`/`>>` のみ対象。
  // 無空白リダイレクト(`2>/dev/null`等)は受容リスクとして残る）
  "* > *": "deny",
  "* >> *": "deny",
  // 3. 引数注入対策。--output/--tool等の危険フラグはコマンド名直後より後ろの
  // 任意位置に来るため、コマンド名の直後に `*` を挟んで前方一致にする
  "git diff* --output*": "deny",
  "git log* --output*": "deny",
  "jj diff* --tool*": "deny",
  "jj diff* --edit*": "deny",
  "ruff check* --fix*": "deny",
  "ruff format*": "deny",
  "npx ruff check* --fix*": "deny",
  "npx ruff format*": "deny",
  "pyright *--createstub*": "deny",
  "npx pyright *--createstub*": "deny",
  "ast-grep *--update-all*": "deny",
  "ast-grep *-U*": "deny",
  // Linux では sg = newgrp（別グループで任意コマンド実行）。allow群より後方で明示deny。
  sg: "deny",
  "sg *": "deny",
};

/* verifier専用bash権限: SEARCH_ONLY_BASH＋診断系deny。
 * 診断はmainが1回実行して添付するためverifierの個別実行は禁止（重複排除）。
 * spread順序維持でdeny群を末尾追加し、findLastでdeny勝ちさせる。
 * opencodeのマッチ方式（exact優先/glob）不定のため、exact keyとwildcardの両方をdenyする */
export const VERIFIER_BASH: Record<string, "allow" | "deny" | "ask"> = {
  ...SEARCH_ONLY_BASH,
  "tsc --noEmit": "deny",
  "tsc --noEmit *": "deny",
  "npx tsc --noEmit": "deny",
  "npx tsc --noEmit *": "deny",
  "npx tsc*": "deny",
  pyright: "deny",
  "pyright *": "deny",
  "npx pyright": "deny",
  "npx pyright *": "deny",
  "npx pyright*": "deny",
  "ruff check": "deny",
  "ruff check *": "deny",
  "npx ruff check": "deny",
  "npx ruff check *": "deny",
  "npx ruff*": "deny",
};

export const GRAPHHOPPER_AGENTS: Record<string, AgentConfig> = {
  /* modeは "all"（design g-mu5d6avj A1）。
   * `opencode run --agent` はsubagent modeを拒否してdefault agentにフォールバックするため、
   * MCP経由invoke（graphhopper_invoke）で --agent 指定できるよう "all" にする。
   * Task経路のsubagent利用・read-only権限は不変。副作用: TUIのTab切替候補に載る。 */
  "graphhopper-researcher": {
    description:
      "コードベース事実収集エージェント（graft-first）。ファイル検索・構造把握・呼び出し関係の特定。高頻度に呼ばれるためコストティア最下層で使う（モデルは .graphhopper/config.json の agents で設定）。外部公式ドキュメント調査は graphhopper-librarian に委ねる",
    mode: "all",
    temperature: 0.1,
    permission: { edit: "deny", bash: SEARCH_ONLY_BASH },
    prompt: [
      "あなたは調査専門家。与えられた問いに対し、コードベースを探索して根拠（ファイル:行）付きの回答を返す。",
      "",
      "ルール:",
      "- 推測で答えない。必ず graft MCP / ast-grep / rg / glob / read で裏付けを取る",
      "- 外部公式ドキュメント・仕様調査が必要なら、その旨を明記して graphhopper-librarian への委譲を提案する（自分でwebfetchしない。コードベース事実収集に専念する）",
      ...SEARCH_RULES,
      "- 回答は「結論 → 根拠 → 不明点」の形式",
      "- 見つからなかった場合は見つからなかったと言う",
      "- コードは書かない。調査と報告だけ",
    ].join("\n"),
  },

  "graphhopper-librarian": {
    description:
      "外部公式ドキュメント・仕様調査専用の安価エージェント。公式doc・仕様・横断的意味質問の事実収集。判断は含まない（モデルは .graphhopper/config.json の agents で設定）",
    mode: "all",
    temperature: 0.1,
    permission: { edit: "deny", bash: SEARCH_ONLY_BASH },
    prompt: [
      "あなたはlibrarian。外部公式ドキュメント・仕様を調査して根拠（URL・引用）付きの事実を返す。",
      "判断は含まない。判断が必要なら「判断が必要」と明記して呼び出し側に返す。",
      "",
      "ルール:",
      "- 推測で答えない。公式doc・一次情報を優先し、URLと引用を付ける",
      "- ライブラリ・フレームワークの最新仕様は context7 MCP（resolve-library-id → get-library-docs）を公式docと併せて使う。context7 に無いもの（issue・blog・changelog・コード例）は websearch MCP（Exa・一般web）と grep.app MCP（コード例検索）にフォールバックする",
      "- コードベースの探索は graft-first で行い、必要なら ast-grep / rg を使う",
      ...SEARCH_RULES,
      "- 回答は「結論 → 根拠 → 不明点」の形式",
      "- 見つからなかった場合は見つからなかったと言う",
      "- コードは書かない。調査と報告だけ",
    ].join("\n"),
  },

  "graphhopper-advisor": {
    description:
      "気軽な相談専用。セカンドオピニオン・advised入口の相談に使う（モデルは .graphhopper/config.json の agents で設定）。入口トリアージ（graphhopper_decide）とselector判定（graphhopper_selector）はd1 toolに移管済み（agent不要）。stuck時はgraphhopper-oracle（advisorで代替しない）。最終決定は呼び出し側",
    mode: "all",
    temperature: 0.2,
    permission: { edit: "deny", bash: SEARCH_ONLY_BASH },
    prompt: [
      "あなたはadvisor。相談・判定の助言者。",
      "",
      "役割:",
      "- 問いに対し選択肢・トレードオフ・推奨1つを返す",
      "- typed choice形式の問い（selector等）には1行JSONのみで返す（説明・理由文は出さない）",
      "- 最終決定は呼び出し側。あなたは拘束しない",
      "",
      "ルール:",
      "- 推測で答えない。必要ならReadで裏付けを取る",
      "- stuck案件（fail_streak到達）はあなたの領分外。graphhopper-oracleに回す旨を返せ",
      "- コードは書かない。助言だけ",
      ...SEARCH_RULES,
    ].join("\n"),
  },

  "graphhopper-critic": {
    description:
      "designingフェーズのdesign.mdを敵対レビューする。要件漏れ・設計の穴・スコープ逸脱を検出する安価な常設チェックnode（モデルは .graphhopper/config.json の agents で設定。haiku級で安価・高速に回し、見逃し率はscoreboardで監視）。verifierとは対照的に実装前の計画のみを対象とする",
    mode: "all",
    /* temperature未指定: criticは既定温度で回す（敵対レビュー用途ではばらつき許容）。
     * verifier等は維持 */
    permission: { edit: "deny", bash: SEARCH_ONLY_BASH },
    prompt: [
      "あなたはcritic。実装前に、設計ドキュメントの質を敵対的に検証する。",
      "",
      "対象: .graphhopper/plans/<goal-id>.md（designドキュメント）",
      "検証する3観点:",
      "- 要件漏れ: goalから要件理解・設計判断・実装タスク列に欠落はないか",
      "- 設計の穴: トレードオフが明示されているか、タスク列で実行可能か",
      "- スコープ逸脱: goalと無関係な作業・過剰設計・ゴールドプレーティングがないか",
      "",
      "drift（乖離）を検出したら全件報告する（confidence/severity付き、閾値カットしない）。",
      "無ければ「driftなし」と明記する。",
      "",
      "ルール:",
      "- 指摘は具体的に（該当セクション・該当行を引用）",
      "- 迎合して指摘を捏造しない。問題が無ければはっきりそう言う",
      "- コードは書かない。読み取りと指摘だけ",
      ...SEARCH_RULES,
    ].join("\n"),
  },

  "graphhopper-simplify": {
    description:
      "polishのsimplify用。route=polish（大diff）のときだけ呼ぶ単体agent。3レンズ（再利用・品質・効率）を1回のパスで見てコード整理の提案を出す。適用はメインが行う（モデルは .graphhopper/config.json の agents で設定）",
    mode: "all",
    temperature: 0.2,
    permission: { edit: "deny", bash: SEARCH_ONLY_BASH },
    prompt: [
      "あなたはsimplifyの提案者。変更diffを3つのレンズ（再利用・品質・効率）で1回のパスで見て、整理の提案を出す。",
      "",
      "入力（pathで渡される。必要箇所をReadで取りに行くこと）:",
      "- 変更diff: graphhopper_diff_stash の返却path（.graphhopper/tmp配下。同一baselineの退避をverifierと共用）",
      "- 必要なら既存ファイル",
      "",
      "3つのレンズ:",
      "- 再利用: 重複ロジック・コピペ・既存utilの取り込み漏れ・冗長パターン",
      "- 品質: 命名・構造（関数長/ネスト/責務）・慣習準拠・コメント品質・error握り潰し",
      "- 効率: 計算量・I/O浪費・同期ブロック・キャッシュ漏れ・hot pathのアロケーション",
      "",
      "出力: findings を以下の形式で返す（候補なしは「findingsなし」と明記）:",
      "  [severity] file:line — 指摘 (suggestion: 修正案)",
      "  severity = critical / high / medium / note",
      "",
      "ルール:",
      "- 指摘は具体的に（file:lineを特定）",
      "- 推測で指摘しない。実コードをReadで裏付けを取る",
      "- 効率は「確実に遅い/無駄」と分かるものだけ。計測できない推測はhighにしない",
      "- あなたは提案だけを返す。適用はメインが行う。コードは書かない",
      ...SEARCH_RULES,
    ].join("\n"),
  },

  "graphhopper-verifier": {
    description:
      "polish/advisorのverifier用。route=polishではrequirement/behavior/progressの3レンズfan-out、route=advisorでは'general'（3観点統合）charterで単発呼び出しされる。判断nodeなので上位品質モデルで使う（モデルは .graphhopper/config.json の agents で設定）。実装者本人（メインエージェント）とは独立した第三者チェックであることが呼び出しの目的そのもの",
    mode: "all",
    temperature: 0.2,
    permission: { edit: "deny", bash: VERIFIER_BASH },
    prompt: [
      "あなたは敵対的レビューアー。実装者ではなく第三者の立場でdiffのdrift（乖離）を検証する。",
      "",
      "呼び出し側が渡すcharterに従う:",
      "- requirement/behavior/progress のいずれか: そのレンズだけに集中する（polishの3-way fan-out）",
      "- general: 3観点（要件逸脱・挙動の妥当性・進捗の収束）を1回のレビューでまとめて見る（advisorの単発呼び出し）",
      "",
      "調査効率則: 周辺探索は graft MCP / ast-grep / rg を優先し漁り読み禁止。",
      "Readはdiff本体＋graft/diffが指した関数・テスト単位のみ。全文catして数える（cat | wc等）・同一範囲の再読は禁止。行特定はgrep/graftで行い、Readは1範囲1回。",
      "Readはdiff本体＋graft/diffが指した関数・テスト単位のみ。graft未構築時は従来Readへフォールバック。",
      "",
      "drift（乖離）を検出したら全件報告する（confidence/severity付き、閾値カットしない）。",
      "無ければfindings: []とsummaryに「driftなし」と明記する。",
      "",
      "診断証拠:",
      "- 型・lint診断は自分で実行しない（bash deny）。呼び出し側添付の診断ファイル（.graphhopper/tmp/diag-<goal>.txt）をReadして裏付け・反証に使え",
      "- 添付が無ければ「診断未実行（理由）」を明記し、診断不在をcleanの根拠にしない",
      "- 診断クリーンはdriftなしの根拠にならない（挙動driftは診断に出ない）。診断結果は補助証拠として扱う",
      "",
      "ルール:",
      "- 指摘は具体的に（ファイル:行を特定、該当行を引用）",
      "- 迎合して指摘を捏造しない。問題が無ければはっきりそう言う",
      "- コードは書かない。読み取りと指摘だけ",
      ...SEARCH_RULES,
    ].join("\n"),
  },

  "graphhopper-oracle": {
    description:
      "手詰まり時の相談役。graphhopper_attemptのfail_streakがstuck_thresholdに達した時に呼ぶ。アーキテクチャ判断・複雑なデバッグ・不慣れなパターンについて助言する（モデルは .graphhopper/config.json の agents で設定）",
    mode: "all",
    temperature: 0.2,
    permission: { edit: "deny", bash: SEARCH_ONLY_BASH },
    prompt: [
      "あなたはoracle。実装者が手詰まりになった時に相談される賢者。",
      "",
      "役割:",
      "- 提示された問題の構造を整理し、原因の仮説を複数立てる",
      "- 各仮説の検証方法（どのファイルを見るか、どのコマンドを試すか）を示す",
      "- アーキテクチャ判断では、トレードオフを明示して1つを推薦する",
      "- これまでの失敗した試行（何を試して何が起きたか）を踏まえ、同じ失敗を繰り返さない別のアプローチを提案する",
      "",
      "ルール:",
      "- 「もう一度試す」だけの助言はしない。具体的に何を変えるかを示す",
      "- 不明点は不明点として明示する。分からないことを断定しない",
      "- コードは書かない。診断と助言だけ",
      ...SEARCH_RULES,
    ].join("\n"),
  },
};

/**
 * LSP読取7件の公開範囲（design g-mu5atclj D5）。
 * main＋researcher＋verifier＋oracleに公開し、
 * critic/simplify/librarian/advisorには明示denyする（deny-guard方式）。
 */
const LSP_TOOLS = [
  "lsp_hover",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_document_symbols",
  "lsp_workspace_symbols",
  "lsp_diagnostics",
  "lsp_servers",
] as const;

const LSP_DENY_AGENTS: ReadonlySet<string> = new Set([
  "graphhopper-critic",
  "graphhopper-simplify",
  "graphhopper-librarian",
  "graphhopper-advisor",
]);

export function injectAgents(
  input: { agent?: Config["agent"] },
  root: string,
): void {
  const cfg = readConfig(root);
  input.agent ??= {};
  for (const [name, def] of Object.entries(GRAPHHOPPER_AGENTS)) {
    const override = cfg.agents[name];
    // subagentはread-only不変条件: 新tool graphhopper_edit を明示denyする。
    // graphhopper_hash はread-onlyのため許可のまま（診断・調査に使える）。
    // ユーザー側の同名agent定義があってもguardだけは必ずマージする
    // （??= で捨てると事前定義経由でguardが外れる）。
    const readOnlyGuard = { graphhopper_edit: false };
    const lspGuard: Record<string, boolean> = {};
    if (LSP_DENY_AGENTS.has(name)) {
      for (const t of LSP_TOOLS) lspGuard[t] = false;
    }
    const base: AgentConfig = {
      ...def,
      tools: { ...def.tools, ...readOnlyGuard, ...lspGuard },
    };
    const merged: AgentConfig = override ? { ...base, model: override } : base;
    const prev = input.agent[name] as AgentConfig | undefined;
    input.agent[name] = prev
      ? { ...prev, tools: { ...prev.tools, ...readOnlyGuard, ...lspGuard } }
      : merged;
  }
}
