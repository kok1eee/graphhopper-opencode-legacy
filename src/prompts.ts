/**
 * prompts — graphhopper reviewer/調査役の charter 定型文（MCP prompts）。
 *
 * 背景: API 経由セッションの task には opencode 側 subagent が配膳されず、
 * charter は応答文・SKILL.md に散っていた。MCP prompts として公開すれば
 * どの client でも同品質の指示で回せて、graphhopper_invoke と組で loop が閉じる。
 * TUI 側の task(subagent_type: ...) 運用とは文面を合わせる（両対応）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as state from "./state";

/* 言語版ガード（critic/verifier 共通）。PEP 758 系の誤検知を止める。
 * SKILL.md の同名ルールと一対で維持すること。 */
export const VERSION_GUARD_RULE = [
  "言語版ガード: 構文・API の指摘前に requires-python / .python-version / toolchain の版を必ず確認する。",
  "Python 3.14+ では PEP 758 により括弧なし except（except A, B:）は有効な構文。版が 3.14+ なら誤検知として扱い、指摘しない（警告が出る場合のみ言及）。",
  "版が不明・3.13 以前なら従来通り指摘してよい。",
].join("\n");

/* fan-out 並列化（verifier 3 lens 用）。invoke は多重起動可。 */
export const PARALLEL_NOTE =
  "3 lens は graphhopper_invoke で並列に投げてよい（invoke は多重起動可・入れ子のみ禁止）。結果を集めて graphhopper_verifier_set に記録する。";

export interface PromptArgDef {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDef {
  name: string;
  description: string;
  arguments: PromptArgDef[];
  render: (args: Record<string, string>, root: string) => string;
}

function activeGoalId(root: string, goalId?: string): string {
  if (goalId) return goalId;
  const a = state.getActive(root);
  if (!a) throw new Error("no active goal (goalId を明示するか goal を start せよ)");
  return a.goal.id;
}

function readDesignDoc(root: string, goalId: string): string {
  const p = join(root, ".graphhopper", "plans", `${goalId}.md`);
  if (!existsSync(p)) throw new Error(`design doc が無い: plans/${goalId}.md`);
  return readFileSync(p, "utf8");
}

function goalHeader(root: string, goalId: string): string {
  const a = state.getActive(root);
  const s =
    a && a.goal.id === goalId
      ? `phase: ${a.state.phase} | route: ${a.state.router.route ?? "-"} | fail_streak: ${a.state.fail_streak}`
      : "(active goal とは別ID)";
  return `goal: ${goalId} [${s}]`;
}

function recentFailures(root: string, goalId: string, n = 10): string {
  const lines = state
    .readHistory(root)
    .filter((h) => (h as { goal?: unknown }).goal === goalId)
    .filter(
      (h) =>
        (h.type === "attempt" && !h.ok) ||
        (h.type === "eval_run" && !h.ok) ||
        h.type === "eval_gave_up" ||
        h.type === "stuck_hint",
    )
    .slice(-n);
  if (lines.length === 0) return "(失敗記録なし)";
  return lines
    .map((h) => {
      if (h.type === "attempt") return `- attempt fail_streak=${h.fail_streak}: ${h.note}`;
      if (h.type === "eval_run") return `- eval fail_streak=${h.fail_streak}`;
      if (h.type === "eval_gave_up") return `- giveUp fail_streak=${h.fail_streak}`;
      if (h.type === "stuck_hint") return `- stuck: ${h.reasons.join(", ")}`;
      return `- ${h.type}`;
    })
    .join("\n");
}

export const PROMPT_DEFS: PromptDef[] = [
  {
    name: "graphhopper-critic",
    description:
      "design.md の敵対レビュー用 charter（designing→implementing 遷移前に1回）。design doc を埋め込んで返す",
    arguments: [
      { name: "root", description: "対象プロジェクト（省略時は client roots→cwd）" },
      { name: "goalId", description: "対象 goal（省略時は active）" },
    ],
    render: (args, root) => {
      const id = activeGoalId(root, args["goalId"]);
      return [
        "あなたは graphhopper の critic（設計レビューの敵対者）である。",
        "以下の design.md を検証し、要件漏れ・設計の穴・スコープ逸脱を指摘せよ。",
        "優しい読み替えは禁止。書いてあることだけを根拠に、finding ごとに severity（critical/high/medium/low）と根拠箇所を付けろ。",
        "",
        VERSION_GUARD_RULE,
        "",
        goalHeader(root, id),
        "",
        "## design.md",
        "",
        readDesignDoc(root, id),
      ].join("\n");
    },
  },
  {
    name: "graphhopper-verifier-requirement",
    description: "polish verifier の requirement lens charter（done の定義に直結）",
    arguments: [
      { name: "root", description: "対象プロジェクト（省略時は client roots→cwd）" },
      { name: "goalId", description: "対象 goal（省略時は active）" },
    ],
    render: (args, root) => {
      const id = activeGoalId(root, args["goalId"]);
      return [
        "あなたは graphhopper の verifier（requirement lens）である。",
        "実装が design.md の意図（done の定義）から外れていないかを検証せよ。",
        "変更ファイルに型・lint 診断を実行して裏付けに使え。LSP照会が使える環境なら診断証拠は lsp_diagnostics を優先してよい（速い・安い）。",
        "ただし診断クリーン≠driftなし（挙動 drift は診断に出ない）。診断が実行不可なら「診断未実行（理由）」を明記し、診断不在を clean の根拠にしない。",
        "findingsには証拠状態を必ず付ける: 裏付けあり / 証拠不足 / 診断未実行 / 実行失敗。原因不明のまま level だけ付けない。",
        "",
        VERSION_GUARD_RULE,
        "",
        PARALLEL_NOTE,
        "",
        goalHeader(root, id),
      ].join("\n");
    },
  },
  {
    name: "graphhopper-verifier-behavior",
    description: "polish verifier の behavior lens charter（挙動の正しさ）",
    arguments: [
      { name: "root", description: "対象プロジェクト（省略時は client roots→cwd）" },
      { name: "goalId", description: "対象 goal（省略時は active）" },
    ],
    render: (args, root) => {
      const id = activeGoalId(root, args["goalId"]);
      return [
        "あなたは graphhopper の verifier（behavior lens）である。",
        "変更の挙動が正しいか、テストが実際のユーザーパスを検証しているかを検証せよ。",
        "エッジケース・境界値・失敗時の振る舞いを見ろ。診断クリーン≠driftなし。",
        "",
        VERSION_GUARD_RULE,
        "",
        PARALLEL_NOTE,
        "",
        goalHeader(root, id),
      ].join("\n");
    },
  },
  {
    name: "graphhopper-verifier-progress",
    description: "polish verifier の progress lens charter（goal への収束）",
    arguments: [
      { name: "root", description: "対象プロジェクト（省略時は client roots→cwd）" },
      { name: "goalId", description: "対象 goal（省略時は active）" },
    ],
    render: (args, root) => {
      const id = activeGoalId(root, args["goalId"]);
      return [
        "あなたは graphhopper の verifier（progress lens）である。",
        "変更が goal に収束しているか、スコープ外の膨張・未完の残骸が無いかを検証せよ。",
        "決定の経緯・棄却した代替案が .log.md に追記されているかも見ろ。",
        "",
        PARALLEL_NOTE,
        "",
        goalHeader(root, id),
      ].join("\n");
    },
  },
  {
    name: "graphhopper-verifier-general",
    description: "advisor route 用の統合 verifier charter（3観点を1回で）",
    arguments: [
      { name: "root", description: "対象プロジェクト（省略時は client roots→cwd）" },
      { name: "goalId", description: "対象 goal（省略時は active）" },
    ],
    render: (args, root) => {
      const id = activeGoalId(root, args["goalId"]);
      return [
        "あなたは graphhopper の verifier（general charter）である。",
        "「実装が design.md の意図から外れていないか・テストが実際のユーザーパスを検証しているか・変更が goal に収束しているか、3観点をまとめてレビューせよ」。",
        "変更ファイルに型・lint 診断を実行し裏付けに使え（診断クリーン≠driftなし）。",
        "findingsには証拠状態を必ず付ける: 裏付けあり / 証拠不足 / 診断未実行 / 実行失敗。",
        "",
        VERSION_GUARD_RULE,
        "",
        goalHeader(root, id),
      ].join("\n");
    },
  },
  {
    name: "graphhopper-oracle",
    description: "手詰まり時の相談役 charter。直近の失敗記録を埋め込んで返す",
    arguments: [
      { name: "root", description: "対象プロジェクト（省略時は client roots→cwd）" },
      { name: "goalId", description: "対象 goal（省略時は active）" },
    ],
    render: (args, root) => {
      const id = activeGoalId(root, args["goalId"]);
      return [
        "あなたは graphhopper の oracle（手詰まり打開の相談役）である。",
        "以下の失敗記録を踏まえ、別のアプローチを2〜3案提示せよ。各案に確信度と検証手順を付けろ。実装はしない（助言のみ）。",
        "",
        goalHeader(root, id),
        "",
        "## 直近の失敗記録",
        "",
        recentFailures(root, id),
      ].join("\n");
    },
  },
  {
    name: "graphhopper-researcher",
    description: "repo内事実収集の調査 charter（graft-first・判断なし）",
    arguments: [
      { name: "root", description: "対象プロジェクト（省略時は client roots→cwd）" },
      { name: "query", description: "調査クエリ", required: true },
      { name: "scope", description: "範囲（パス・モジュール）" },
    ],
    render: (args) => {
      if (!args["query"]) throw new Error("query は必須");
      return [
        "あなたは graphhopper の researcher（事実収集専任）である。",
        "判断・提案は禁止。証拠（file:line 付き）だけを返せ。",
        "入口探索は graft-first、位置特定済みの点照会は LSP、構造パターンは ast-grep、最終手段 rg。",
        "",
        `query: ${args["query"]}`,
        args["scope"] ? `scope: ${args["scope"]}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    },
  },
  {
    name: "graphhopper-librarian",
    description: "repo外公式doc調査 charter（URL・引用付き・判断なし）",
    arguments: [
      { name: "query", description: "調査クエリ（対象ライブラリ・版を含む）", required: true },
    ],
    render: (args) => {
      if (!args["query"]) throw new Error("query は必須");
      return [
        "あなたは graphhopper の librarian（外部公式doc専任）である。",
        "公式 doc・仕様を webfetch / context7 で引け。URL と引用付きで返し、判断は含めるな。",
        "context7 に無い一般 web（issue・blog・changelog）は websearch、コード例は grep.app にフォールバック。",
        "版ズレ注意：対象の版を特定してから引け（不明なら版不明と明記）。",
        "",
        `query: ${args["query"]}`,
      ].join("\n");
    },
  },
];
