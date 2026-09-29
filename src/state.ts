/**
 * graphhopper state 管理
 *
 * `.graphhopper/` 配下の JSON/JSONL ファイルを読み書きする。
 * - goals.json    : 目標キューと active 指定
 * - state.json    : 現在のループ状態（フェーズ・セッション紐付け・verifier サブステート）
 * - config.json   : プロジェクト毎の上書き設定（任意）
 * - history.jsonl : 監査ログ（append-only）
 * - plans/<goal-id>.md : design ドキュメント（designing フェーズで書く唯一の許可パス）
 *
 * config は「グローバル既定 → プロジェクト上書き」の2層で解決する（readConfig）。
 * グローバル既定は `~/.config/opencode/graphhopper.json`（`GRAPHHOPPER_CONFIG` で変更可）。
 * 全プロジェクトで同じ agents 設定を使いたい場合はグローバルに1枚置けばよい。
 *
 * 外部依存なし（node stdlib のみ）。全ての書き込みは tmp+rename で原子的に行う。
 * flywheel-opencode (src/state.ts) の atomic write パターンを踏襲。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** graphhopper 本体（Claude Code版）の3相グラフに合わせる。flywheelの8フェーズより薄い */
export const PHASES = ["designing", "implementing", "polish", "done"] as const;
export type Phase = (typeof PHASES)[number];

export type GoalStatus = "active" | "paused" | "done";

export interface Goal {
  id: string;
  title: string;
  status: GoalStatus;
  created_at: string;
  done_at: string | null;
  /** complete時の機械採点（B）。内訳付き・後方互換のためoptional */
  score?: GoalScore | null;
  /** pause時の文脈スナップショット。別goal走行後のresumeで自文脈に復帰するため */
  paused_snapshot?: GoalSnapshot | null;
}

/** entry相談の種別。advisor＝advised入口の第二意見、oracle＝oracle入口の開始時相談。
 * stuck時のoracle相談とは区別しない（entry gateは遷移時点の存在だけ見る） */
export type ConsultKind = "advisor" | "oracle";

/** entry相談の記録。判定ではなく存在記録のためlevelを持たない（scoreboard汚染防止）。
 * 相談の実在は検証しない（critic_setと同型の既知トレードオフ） */
export interface ConsultRecord {
  summary: string;
  /** 相談を実行したモデル（未指定時はconfig agents表からkind別に補完） */
  model?: string | null;
  at: string;
}

/** pause時に退避するgoal固有文脈（単一LoopStateの使い回しによる漏れ対策） */
export interface GoalSnapshot {
  phase: Phase;
  router: RouterState;
  last_verifier: VerifierVerdict | null;
  critic_review: CriticVerdict | null;
  /** entry相談記録。別goal走行後のresumeで他goalの記録を継承（リーク）／自記録を喪失しないよう退避する */
  advisor_consult: ConsultRecord | null;
  oracle_consult: ConsultRecord | null;
  eval_cmd: string | null;
  notes: string;
  /** goal start時の脏れ。resume後も自goal基準を維持するため退避する */
  initial_diff_lines: number | null;
  /** goal start時の脏れファイル集合。deep判定の差分基準として退避する */
  initial_diff_files: string[] | null;
}

/** goal出来栄えの機械採点。式はv1で固定し、breakdownで透明化する（調整は式ごと変える） */
export interface GoalScore {
  value: number;
  breakdown: {
    rewinds: number;
    maxFailStreak: number;
    gateBlocks: number;
    verifierRounds: number;
  };
}

export type VerdictLevel = "clean" | "drift";
/** drift 巻き戻し先。implementing 以外は人間の hand-back 待ち（flywheelのmonitor相当） */
export type DriftTarget = "implementing" | "design" | "requirements";
/** general: route=advisor の単発呼び出し（3レンズを1つにまとめた統合charter） */
export type VerifierLens = "requirement" | "behavior" | "progress" | "general";

/* jev入口トリアージのroute。null＝full（未呼び出し・legacyの機械定義）。
 * light/advised→full昇格のみ可（full→light禁止のラチェット）。directはgoalを作らない */
export type EntryRoute = "full" | "light" | "direct" | "advised" | "oracle";

/* 旧A/B/C→新名の写像（history既存値はdisk上不変。read時に正規化する） */
const LEGACY_ROUTE_MAP: Record<string, EntryRoute> = {
  A: "full",
  B: "light",
  C: "direct",
};

export function normalizeEntryRoute(v: unknown): EntryRoute | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  const names: EntryRoute[] = ["full", "light", "direct", "advised", "oracle"];
  if ((names as string[]).includes(t)) return t as EntryRoute;
  const legacy = LEGACY_ROUTE_MAP[v.trim().toUpperCase()];
  return legacy ?? null;
}

export interface VerifierVerdict {
  level: VerdictLevel;
  reason: string;
  target: DriftTarget | null;
  lens: VerifierLens[];
  /** 判定を実行したモデル（未指定時はconfig既定で補完）。評価機能の成績表素材 */
  model?: string | null;
  /** lens並列の実行モデル（混成run用。欠測・旧eventは [model] fallback）。
   * 長さは lens と一致させる（setVerifierVerdict がpad/truncateする） */
  models?: (string | null)[];
  at: string;
}

/** designing終了前のdesign.md質レビュー（graphhopper-critic、opt-in・ハードゲート無し）の記録。
 * phase遷移の前提条件にはしない——design時点では客観的な閾値が無く、ゲート化すると
 * 「薄く書いてゲートを避ける」自己判断エロージョンを再生産するだけのため。 */
export interface CriticVerdict {
  level: VerdictLevel;
  reason: string;
  /** レビューを実行したモデル（未指定時はconfig既定で補完） */
  model?: string | null;
  at: string;
}

export type RouterRoute = "advisor" | "polish";

export interface RouterState {
  baseline_rev: string | null;
  diff_lines: number | null;
  route: RouterRoute | null;
  checked_at: string | null;
  /** deep推奨。同一goalの変更がRISK_PATHSに触れたか（recordRouterCheckWithRiskが判定） */
  deep: boolean;
  /** deep=trueの理由（触れたriskファイル列）。false時はnull */
  deep_reason: string | null;
}

export interface LoopState {
  goal_id: string | null;
  /** ループ継続注入の対象セッション。null は未バインド */
  session_id: string | null;
  phase: Phase;
  /** 中断・再開用のメモ（「どこまでやったか」） */
  notes: string;
  /** router gate（loop-driver.sh 相当）が直近に測った diff サイズと分岐先 */
  router: RouterState;
  /** polish フェーズの verifier fan-out 結果。null = 未実行 */
  last_verifier: VerifierVerdict | null;
  /** designing終了前のcritic review結果。null = 未実行（opt-in、setPhaseの前提条件にはしない） */
  critic_review: CriticVerdict | null;
  /** advised入口のadvisor相談記録。null = 未相談（designing→implementingの機械ゲート） */
  advisor_consult: ConsultRecord | null;
  /** oracle入口の開始時相談記録。null = 未相談（designing→implementingの機械ゲート） */
  oracle_consult: ConsultRecord | null;
  /**
   * implementing での連続失敗数（graphhopper_attempt が機械カウント）。
   * stuck_threshold に達したら graphhopper-oracle への相談を促す。
   * ok な attempt か phase 遷移でリセットされる。
   */
  fail_streak: number;
  /**
   * implementing の合否を機械判定するコマンド（graphhopper本体のeval_cmd相当）。
   * 設定されていれば session.idle 発火時に毎回実行し、exit codeで自動的に
   * pass（polishへ遷移）/fail（fail_streakを機械カウント）を判定する。
   * 未設定なら graphhopper_attempt の自己申告にフォールバックする。
   */
  eval_cmd: string | null;
  /**
   * 直近に注入した継続リマインダー時点の進展フィンガープリント
   * （continuationFingerprint の戻り値）。次回 idle 時に同一なら
   * 「前回注入以降に進展なし」とみなして注入をスキップし、待機ackの
   * 言い換え繰り返しによる空転ループを1往復で止める。
   */
  last_continuation_marker: string | null;
  /**
   * 直近の eval_cmd 実行結果のフィンガープリント（ok + 出力tailのハッシュ）。
   * 同一失敗の再注入を抑止しつつ、結果が変わったら注入を再開するための材料。
   */
  last_eval_fingerprint: string | null;
  /**
   * 無限ループ検知（echoループ）の連続カウント。session.idle 発火ごとに
   * 「直前のassistantメッセージとほぼ同一のuserメッセージ」を検知して増える。
   * ループでない（人間の新規入力）と判定されたら0に戻る。
   */
  loop_streak: number;
  /** 無限ループを検知して自動継続注入を停止した「現在の一時状態」か。永続フラグではなく
   * pauseGoal / resumeGoal / completeGoal / 明示 pause / clear で false に戻る。
   * resume の恒久ブロックは loop_stop_count >= loop_stop_max の判定で行う。 */
  loop_stopped: boolean;
  /** ループ検知による自動停止の累積回数（goalごと）。loop_stop_max に達すると resume を
   * 拒否して人間に判断を委ねる。明示 pause はカウントしない。clear で0に戻る。 */
  loop_stop_count: number;
  /** 直近に edit/write されたファイル（正規化前パス）。同一ファイル再編集の
   * 検知アンカー。別ファイル・eval pass・phase 遷移・resume でリセット */
  edit_file: string | null;
  /** 同一ファイルへの連続 edit/write 回数。stuck_edit_repeat に達したら
   * stuck 扱い（堂々巡りの再編集の機械検知） */
  edit_streak: number;
  /** 直近に測定したワーキングコピー差分行数。diff 停滞の検知アンカー */
  last_diff_lines: number | null;
  /** ワーキングコピー差分が変わらない idle  eval 回数。stuck_diff_stall に
   * 達したら stuck 扱い。差分変化・eval pass・phase 遷移・resume でリセット */
  diff_stall: number;
  /** 直近に stuck 通知した理由集合。同一理由の再通知を抑止する。
   * resume でクリアする */
  last_stuck_reasons: string[];
  /** goal start時の未コミット脏れ行数（baseline rev基準）。実効diff＝測定－初期値。
   * null＝legacy/未測定→0扱い。designing中はsource編集不可のためstart時測定で安定 */
  initial_diff_lines: number | null;
  /** goal start時の未コミット脏れファイル集合（正規化済み）。deep判定の差分基準。
   * null＝legacy/未測定→deepなし。snapshotInitialDiffFilesがstart時に記録する */
  initial_diff_files: string[] | null;
  /** jev入口判定のroute。null＝full（未呼び出し・legacy）。light/advised→full昇格のみ可 */
  entry_route: EntryRoute | null;
  /** light/advised→full昇格の実施時刻。null＝未昇格 */
  escalated_at: string | null;
  updated_at: string;
}

export interface GoalsFile {
  goals: Goal[];
  active: string | null;
}

export interface GraphhopperConfig {
  /** router gate の分岐閾値（diff行数）。超えたら polish、以下なら advisor 相当の自己レビューで足りる */
  router_threshold_lines: number;
  /** designing フェーズで編集を許可する path（glob不可、prefix一致）。デフォルトは plans/ 配下のみ */
  design_gate_allow: string[];
  /** subagent 名で model を上書きする（例: { "graphhopper-verifier": "amazon-bedrock/anthropic.claude-opus-5" }） */
  agents: { [name: string]: string };
  /** implementing の連続失敗数がこれに達したら graphhopper-oracle への相談を促す */
  stuck_threshold: number;
  /** echoループ（直前のassistantメッセージとほぼ同一のuserメッセージ）を
   * 何回連続で検知したら自動継続注入を止めるか。0以下なら echo 検知を無効化
   * （tool検知は loop_tool_repeat_threshold で独立に制御される） */
  loop_stop_threshold: number;
  /** ループ検知による自動停止が累積 loop_stop_max 回に達したら resume を拒否する
   * （人間が force:true で明示解除するか clear するまで）。0以下なら resume ブロック無効 */
  loop_stop_max: number;
  /** 同一tool call反復検知のウィンドウ幅（対象は最後の人間user入力以降の tool call のうち
   * 直近この件数）。0以下なら無効 */
  loop_tool_window: number;
  /** 直近 loop_tool_window 件の tool call 内で同一 (tool名+入力ハッシュ) がこの回数
   * 出たらループと判定する。1以下なら tool 検知を無効化 */
  loop_tool_repeat_threshold: number;
  /** eval_cmd / attempt の連続失敗数がこれに達したら giveUp し goal を pause する
   * （既定 6 = stuck_threshold 既定 3 の2倍。fail 3,4,5 で escalate 相談→
   * 改善なければ 6 で諦めの順序）。0以下で無効。有効時は stuck_threshold
   * 以上にクランプされる（相談前に諦める逆転を防ぐ） */
  max_eval_fails: number;
  /** 同一ファイルへの連続 edit/write がこの回数に達したら stuck 扱いにする。
   * 1以下で無効 */
  stuck_edit_repeat: number;
  /** ワーキングコピー差分が変わらない idle eval がこの回数続いたら stuck 扱い。
   * 1以下で無効 */
  stuck_diff_stall: number;
  /** 追加LSP server定義（design g-mu5atclj D4）。同extensionsはbuiltinを上書き、未知は追記 */
  lsp_servers: { command: string; args: string[]; extensions: string[] }[];
  /** trueで designing→implementing 遷移に critic_review 記録を要求する。
   * 既定 false（opt-in維持。ゲート化の是非は未決のためflagで両対応） */
  require_critic: boolean;
}

export const DEFAULT_CONFIG: GraphhopperConfig = {
  router_threshold_lines: 400,
  design_gate_allow: [".graphhopper/plans/"],
  agents: {},
  stuck_threshold: 3,
  loop_stop_threshold: 6,
  loop_stop_max: 3,
  loop_tool_window: 8,
  loop_tool_repeat_threshold: 4,
  max_eval_fails: 6,
  stuck_edit_repeat: 5,
  stuck_diff_stall: 4,
  lsp_servers: [],
  require_critic: false,
};

function dir(root: string): string {
  return join(root, ".graphhopper");
}

function goalsPath(root: string): string {
  return join(dir(root), "goals.json");
}

function statePath(root: string): string {
  return join(dir(root), "state.json");
}

function configPath(root: string): string {
  return join(dir(root), "config.json");
}

/** 全プロジェクト共通の既定設定。`GRAPHHOPPER_CONFIG` で明示指定も可能。 */
function globalConfigPath(): string {
  return (
    process.env.GRAPHHOPPER_CONFIG ??
    join(homedir(), ".config", "opencode", "graphhopper.json")
  );
}

function historyPath(root: string): string {
  return join(dir(root), "history.jsonl");
}

export function planPath(root: string, goalId: string): string {
  return join(dir(root), "plans", `${goalId}.md`);
}

/* design doc scaffold: goal開始時に骨格を自動生成する。
 * 構造検証（gate.ts checkDesignDoc）のアンカー。既存ファイルは壊さない（冪等）。 */
export function designTemplate(goalId: string, title: string): string {
  return [
    `# design: ${title} (${goalId})`,
    ``,
    `## 1. goal理解`,
    ``,
    `（何を・なぜやるか。1〜3文）`,
    ``,
    `## 2. 現状`,
    ``,
    `（調査済み事実。証拠付き）`,
    ``,
    `## 3. 設計判断`,
    ``,
    `（採用・棄却の判断と理由）`,
    ``,
    `## 4. 実装タスク列`,
    ``,
    `- [ ] T1 （タスク）`,
    ``,
    `## 5. 棄却した代替案`,
    ``,
    `| 対象 | 採用 | 棄却 |`,
    `|---|---|---|`,
    ``,
  ].join("\n");
}

/** scaffoldが無ければ生成する。生成したら true、既存なら false */
export function scaffoldDesignDoc(root: string, goalId: string, title: string): boolean {
  try {
    const p = planPath(root, goalId);
    if (existsSync(p)) return false;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, designTemplate(goalId, title), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 決定の経緯・棄却した代替案・進捗を追記するログ（design docとは別物、追記専用・ハードゲート無し）。
 * design_gate_allow の prefix (`.graphhopper/plans/`) に含まれるため、designing中も常時書き込み可能。 */
export function planLogPath(root: string, goalId: string): string {
  return join(dir(root), "plans", `${goalId}.log.md`);
}

export function planLogExists(root: string, goalId: string): boolean {
  return existsSync(planLogPath(root, goalId));
}

export type HistoryEvent =
  | { type: "goal_start"; goal: string; title: string }
  | { type: "goal_pause"; goal: string }
  | { type: "goal_resume"; goal: string }
  | { type: "goal_complete"; goal: string; score?: number | null }
  | { type: "phase"; goal: string; from: Phase; to: Phase; notes?: string }
  | {
      type: "router_check";
      goal: string;
      diff_lines: number;
      route: RouterRoute;
      deep?: boolean;
      deep_reason?: string | null;
    }
  | {
      type: "verifier_verdict";
      goal: string;
      level: VerdictLevel;
      target: DriftTarget | null;
      lens: VerifierLens[];
      model?: string | null;
      /** lens並列の実行モデル（混成run用。旧eventは欠測→[model] fallback） */
      models?: (string | null)[];
    }
  | { type: "design_gate_block"; goal: string; tool: string; path: string }
  | {
      type: "design_doc_locked_block";
      goal: string;
      tool: string;
      path: string;
    }
  | {
      type: "critic_review_set";
      goal: string;
      level: VerdictLevel;
      model?: string | null;
    }
  | {
      /* entry相談の記録。判定ではなく存在記録のためlevelを持たない
       *（scoreboard汚染防止。switchはdefaultのまま） */
      type: "consult_set";
      goal: string;
      kind: ConsultKind;
      model?: string | null;
    }
  | {
      type: "attempt";
      goal: string;
      ok: boolean;
      fail_streak: number;
      note: string;
    }
  | { type: "eval_set"; goal: string; cmd: string }
  | { type: "eval_run"; goal: string; ok: boolean; fail_streak: number }
  | { type: "eval_gave_up"; goal: string; fail_streak: number }
  | { type: "stuck_hint"; goal: string; reasons: string[] }
  | {
      type: "loop_detected";
      goal: string;
      kind: LoopKind;
      streak: number;
      stopped: boolean;
    }
  | { type: "loop_stopped"; goal: string; count: number }
  | { type: "loop_resume_forced"; goal: string }
  | { type: "continuation_skipped"; goal: string; marker: string }
  | { type: "hash_edit_applied"; goal: string; path: string }
  | {
      type: "hash_edit_refused";
      goal: string;
      path: string;
      reason: string;
    }
  | {
      /* jev入口判定の記録。Cはgoalを作らないためgoal任意。
       * 監査用1行（誤Cの検知・回収のためhistoryには残す） */
      type: "entry_route";
      goal?: string;
      route: EntryRoute;
      reason?: string;
    }
  | { type: "escalated"; goal: string; from: EntryRoute; at: string }
  | {
      /* 改善ループ用per-goal集計行。complete時にgoal_completeと2行1appendで同時書き込み。
       * 全てhistory由来の機械事実。欠測はnull（entry_route未記録のみ"full"）。
       * last-write集計（entry_routeのみfirst＝昇格前。escalatedと組合せて区別） */
      type: "goal_summary";
      goal: string;
      title: string;
      duration_s: number | null;
      entry_route: EntryRoute;
      router_route: RouterRoute | null;
      diff_lines: number | null;
      lenses: VerifierLens[];
      verdict_level: VerdictLevel | null;
      verdict_target: DriftTarget | null;
      max_fail_streak: number;
      escalated: boolean;
      critic_level: VerdictLevel | null;
      rewinds: number;
      verifier_rounds: number;
      score: number | null;
    };

/** append-only の履歴ログ。LLMの自己申告ではなくplugin機械記録の監査証跡 */
export function recordEvent(root: string, event: HistoryEvent): void {
  try {
    mkdirSync(dir(root), { recursive: true });
    const record = { ts: new Date().toISOString(), ...event };
    const line = JSON.stringify(record) + "\n";
    appendFileSync(historyPath(root), line, "utf8");
    writeOutbox(root, record);
  } catch {
    // 履歴書き込み失敗でループを止めない
  }
}

/* ================================================================== *
 * outbox（durable通知）: プログラムが受け取れる完了・異常通知。
 * 会話上の「終わったよ」ではなくファイルで受け取る。watcher試作が読む。
 * curated種別のみ投下し、上限超は古いものから刈る。失敗しても本線を壊さない。
 * ================================================================== */

const OUTBOX_KEEP = 100;

/** outboxに投下する種別（完了・drift・諦め・停止のみ。attempt等の高頻度は対象外） */
const OUTBOX_EVENTS: ReadonlySet<string> = new Set([
  "goal_complete",
  "verifier_verdict",
  "eval_gave_up",
  "loop_stopped",
]);

function outboxPath(root: string): string {
  return join(dir(root), "outbox");
}

function writeOutbox(
  root: string,
  record: { ts: string; type: string; goal?: unknown },
): void {
  try {
    if (!OUTBOX_EVENTS.has(record.type)) return;
    mkdirSync(outboxPath(root), { recursive: true });
    const stamp = record.ts.replace(/[:.]/g, "-");
    const goal = typeof record.goal === "string" ? record.goal : "nogoal";
    writeFileSync(
      join(outboxPath(root), `${stamp}-${record.type}-${goal}.json`),
      JSON.stringify(record, null, 2) + "\n",
      "utf8",
    );
    const files = readdirSync(outboxPath(root))
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - OUTBOX_KEEP))) {
      try {
        unlinkSync(join(outboxPath(root), f));
      } catch {
        // 刈り取り失敗は無視
      }
    }
  } catch {
    // outbox失敗で本線を壊さない
  }
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function atomicWrite(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function readConfig(root: string): GraphhopperConfig {
  // グローバル既定 < プロジェクト上書き。agents だけは name 単位でマージする
  // （プロジェクト側で一部の subagent だけ別モデルに差し替えられるように）。
  const global = readJson<Partial<GraphhopperConfig>>(globalConfigPath(), {});
  const project = readJson<Partial<GraphhopperConfig>>(configPath(root), {});
  const raw: Partial<GraphhopperConfig> = {
    ...global,
    ...project,
    agents: { ...(global.agents ?? {}), ...(project.agents ?? {}) },
  };
  const stuck_threshold =
    raw.stuck_threshold ?? DEFAULT_CONFIG.stuck_threshold;
  const maxRaw = raw.max_eval_fails ?? DEFAULT_CONFIG.max_eval_fails;
  return {
    router_threshold_lines:
      raw.router_threshold_lines ?? DEFAULT_CONFIG.router_threshold_lines,
    design_gate_allow:
      raw.design_gate_allow ?? DEFAULT_CONFIG.design_gate_allow,
    agents: { ...(DEFAULT_CONFIG.agents ?? {}), ...(raw.agents ?? {}) },
    stuck_threshold,
    loop_stop_threshold:
      raw.loop_stop_threshold ?? DEFAULT_CONFIG.loop_stop_threshold,
    loop_stop_max: raw.loop_stop_max ?? DEFAULT_CONFIG.loop_stop_max,
    loop_tool_window:
      raw.loop_tool_window ?? DEFAULT_CONFIG.loop_tool_window,
    loop_tool_repeat_threshold:
      raw.loop_tool_repeat_threshold ??
      DEFAULT_CONFIG.loop_tool_repeat_threshold,
    // 相談 (stuck) より諦め (giveUp) が先に発火しないよう下限を揃える
    max_eval_fails: maxRaw <= 0 ? maxRaw : Math.max(maxRaw, stuck_threshold),
    stuck_edit_repeat:
      raw.stuck_edit_repeat ?? DEFAULT_CONFIG.stuck_edit_repeat,
    stuck_diff_stall:
      raw.stuck_diff_stall ?? DEFAULT_CONFIG.stuck_diff_stall,
    lsp_servers: raw.lsp_servers ?? DEFAULT_CONFIG.lsp_servers,
    require_critic: raw.require_critic ?? DEFAULT_CONFIG.require_critic,
  };
}

export function readGoals(root: string): GoalsFile {
  return readJson<GoalsFile>(goalsPath(root), { goals: [], active: null });
}

function emptyState(): LoopState {
  return {
    goal_id: null,
    session_id: null,
    phase: "designing",
    notes: "",
    router: {
      baseline_rev: null,
      diff_lines: null,
      route: null,
      checked_at: null,
      deep: false,
      deep_reason: null,
    },
    last_verifier: null,
    critic_review: null,
    advisor_consult: null,
    oracle_consult: null,
    fail_streak: 0,
    eval_cmd: null,
    last_continuation_marker: null,
    last_eval_fingerprint: null,
    loop_streak: 0,
    loop_stopped: false,
    loop_stop_count: 0,
    edit_file: null,
    edit_streak: 0,
    last_diff_lines: null,
    diff_stall: 0,
    last_stuck_reasons: [],
    entry_route: null,
    escalated_at: null,
    initial_diff_lines: null,
    initial_diff_files: null,
    updated_at: new Date().toISOString(),
  };
}

export function readState(root: string): LoopState {
  const loaded = readJson<Partial<LoopState>>(statePath(root), emptyState());
  const merged: LoopState = {
    ...emptyState(),
    ...loaded,
    router: { ...emptyState().router, ...(loaded.router ?? {}) },
  };
  // 破損 state.json の未知 phase は designing にフォールバックする。
  // 未検証のまま通すと PHASE_ACTION[phase] 参照が undefined になる。
  if (!(PHASES as readonly string[]).includes(merged.phase)) {
    merged.phase = "designing";
  }
  return merged;
}

function writeGoals(root: string, data: GoalsFile): void {
  atomicWrite(goalsPath(root), data);
}

function writeState(root: string, state: LoopState): void {
  state.updated_at = new Date().toISOString();
  atomicWrite(statePath(root), state);
}

export interface ActiveLoop {
  goal: Goal;
  state: LoopState;
}

/** active な goal と state の組を返す。無ければ null */
export function getActive(root: string): ActiveLoop | null {
  const goals = readGoals(root);
  if (!goals.active) return null;
  const goal = goals.goals.find((g) => g.id === goals.active);
  if (!goal) return null;
  return { goal, state: readState(root) };
}

export function startGoal(
  root: string,
  title: string,
  sessionID: string,
): ActiveLoop {
  const goals = readGoals(root);
  const goal: Goal = {
    id: `g-${Date.now().toString(36)}`,
    title,
    status: "active",
    created_at: new Date().toISOString(),
    done_at: null,
  };
  for (const g of goals.goals) {
    if (g.status === "active") g.status = "paused";
  }
  goals.goals.push(goal);
  goals.active = goal.id;
  writeGoals(root, goals);

  const next: LoopState = {
    ...emptyState(),
    goal_id: goal.id,
    session_id: sessionID,
  };
  // pending entry_route（route_set先行）の消費。無ければnull＝full。
  // directはpendingを書かない（historyのみ）ため消費集合に入れない
  const pending = readPendingRoute(root);
  if (
    pending &&
    (pending.route === "full" ||
      pending.route === "light" ||
      pending.route === "advised" ||
      pending.route === "oracle")
  ) {
    next.entry_route = pending.route;
  }
  clearPendingRoute(root);
  writeState(root, next);
  recordEvent(root, { type: "goal_start", goal: goal.id, title: goal.title });
  if (next.entry_route) {
    recordEvent(root, {
      type: "entry_route",
      goal: goal.id,
      route: next.entry_route,
      reason: pending?.reason,
    });
  }
  // design scaffold: 骨格を自動生成（既存があれば壊さない）。
  // 構造検証ゲートのアンカーになる
  scaffoldDesignDoc(root, goal.id, goal.title);
  return { goal, state: next };
}

function mutateActive(
  root: string,
  fn: (
    goal: Goal,
    state: LoopState,
  ) => Partial<{ goal: Partial<Goal>; state: Partial<LoopState> }>,
): ActiveLoop | null {
  const goals = readGoals(root);
  if (!goals.active) return null;
  const goal = goals.goals.find((g) => g.id === goals.active);
  if (!goal) return null;
  const state = readState(root);
  const patch = fn(goal, state);
  if (patch.goal) Object.assign(goal, patch.goal);
  if (patch.state) Object.assign(state, patch.state);
  writeGoals(root, goals);
  writeState(root, state);
  return { goal, state };
}

export function pauseGoal(root: string): ActiveLoop | null {
  const r = mutateActive(root, (goal, state) => ({
    // pause時にgoal固有文脈をスナップショットする。単一LoopStateを使い回すため、
    // 別goalが走った後のresumeでphase/router/verifierが漏れる事故を防ぐ
    goal: {
      status: "paused",
      paused_snapshot: {
        phase: state.phase,
        router: state.router,
        last_verifier: state.last_verifier,
        critic_review: state.critic_review,
        advisor_consult: state.advisor_consult,
        oracle_consult: state.oracle_consult,
        eval_cmd: state.eval_cmd,
        notes: state.notes,
        initial_diff_lines: state.initial_diff_lines,
        initial_diff_files: state.initial_diff_files,
      },
    },
    // 人間による明示的な操作なのでloop停止フラグも解除（pause自体が駆動を止める）
    state: { loop_streak: 0, loop_stopped: false },
  }));
  if (r) recordEvent(root, { type: "goal_pause", goal: r.goal.id });
  return r;
}

export function resumeGoal(
  root: string,
  sessionID: string,
  force = false,
): ActiveLoop | null {
  // 恒久ブロック: loop_stop_max に達したら通常resumeを拒否（forceで明示解除のみ）
  if (isResumeBlocked(root) && !force) return null;
  const r = mutateActive(root, (goal) => {
    const snap = goal.paused_snapshot;
    return {
      goal: { status: "active" },
      // pause→人間修正→resume の運用で eval リトライ・stuck 信号を数え直すため
      // fail_streak・stuck系も戻す（loop 停止からの resume でも escalate は再カウント）。
      // loop_stop_count（恒久ブロック予算）は維持する
      state: {
        goal_id: goal.id,
        session_id: sessionID,
        loop_streak: 0,
        loop_stopped: false,
        fail_streak: 0,
        edit_file: null,
        edit_streak: 0,
        last_diff_lines: null,
        diff_stall: 0,
        last_stuck_reasons: [],
        // 別goalが走った後のresumeでも自goalの文脈に戻す（snapshotが無ければ現状維持）
        ...(snap
          ? {
              phase: snap.phase,
              router: snap.router,
              last_verifier: snap.last_verifier,
              critic_review: snap.critic_review,
              // 旧snapshot（field無し）→null＝legacy扱い
              advisor_consult: snap.advisor_consult ?? null,
              oracle_consult: snap.oracle_consult ?? null,
              eval_cmd: snap.eval_cmd,
              notes: snap.notes,
              // 旧snapshot（field無し）→null＝legacy扱い
              initial_diff_lines: snap.initial_diff_lines ?? null,
              initial_diff_files: snap.initial_diff_files ?? null,
            }
          : {}),
      },
    };
  });
  if (r) {
    recordEvent(root, { type: "goal_resume", goal: r.goal.id });
    if (force) {
      // 人間の判断を監査証跡に残す（カウンタは保持するため履歴は残る）
      recordEvent(root, { type: "loop_resume_forced", goal: r.goal.id });
    }
  }
  return r;
}

export function completeGoal(root: string): ActiveLoop | null {
  const r = mutateActive(root, () => ({
    goal: { status: "done", done_at: new Date().toISOString() },
    state: {
      phase: "done",
      loop_streak: 0,
      loop_stopped: false,
    },
  }));
  if (r) {
    // complete時の機械採点（B）。式v1: 100 - 15*巻き戻し - 5*最大fail - 3*gate阻止 - 5*(verifier追加round)。下限0
    const score = computeGoalScore(root, r.goal.id);
    const goals = readGoals(root);
    const g = goals.goals.find((x) => x.id === r.goal.id);
    if (g) {
      g.score = score;
      writeGoals(root, goals);
    }
    r.goal.score = score;
    // goal_complete＋goal_summaryの2行1append（片側欠けの窓を1箇所に限定）
    recordEventBatch(root, [
      { type: "goal_complete", goal: r.goal.id, score: score.value },
      buildGoalSummary(root, r.goal.id, { score: score.value }),
    ]);
    // diff退避を掃除（.graphhopper/tmp。蓄積＋古いpath誤読の防止）
    removeStashedDiff(root, r.goal.id);
  }
  return r;
}

/** goal出来栄えの機械採点。history由来の機械事実のみで計算し、人手採点はしない（v1）。
 * 内訳を残すため式の調整はこの関数のみ変える */
export function computeGoalScore(root: string, goalId: string): GoalScore {
  let rewinds = 0;
  let maxFailStreak = 0;
  let gateBlocks = 0;
  let verifierRounds = 0;
  for (const h of readHistory(root)) {
    if ((h as { goal?: unknown }).goal !== goalId) continue;
    switch (h.type) {
      case "phase":
        if (h.from === "polish" && h.to === "implementing") rewinds += 1;
        break;
      case "attempt":
        if (h.fail_streak > maxFailStreak) maxFailStreak = h.fail_streak;
        break;
      case "design_gate_block":
      case "design_doc_locked_block":
        gateBlocks += 1;
        break;
      case "verifier_verdict":
        verifierRounds += 1;
        break;
      default:
        break;
    }
  }
  const breakdown = {
    rewinds,
    maxFailStreak,
    gateBlocks,
    verifierRounds,
  };
  const value = Math.max(
    0,
    100 - 15 * rewinds - 5 * maxFailStreak - 3 * gateBlocks - 5 * Math.max(0, verifierRounds - 1),
  );
  return { value, breakdown };
}

/* 複数eventの一括追記（goal_complete＋goal_summaryの2行1append用。
 * 片側欠けの窓を1箇所に限定する。失敗時は握りつぶす＝本線を壊さない） */
export function recordEventBatch(root: string, events: HistoryEvent[]): void {
  try {
    mkdirSync(dir(root), { recursive: true });
    const now = new Date().toISOString();
    const records = events.map((e) => ({ ts: now, ...e }));
    appendFileSync(
      historyPath(root),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
    for (const r of records) writeOutbox(root, r);
  } catch {
    // 履歴書き込み失敗でループを止めない
  }
}

/** goal_summary行（ts付き。buildTelemetryの要素型） */
export type GoalSummaryRecord = Extract<
  HistoryEvent,
  { type: "goal_summary" }
> & { ts?: string };

/* per-goal集計の構築（history走査。computeGoalScoreと同型）。
 * last-write集計（entry_routeのみfirst＝昇格前）。
 * 未complete・pause中にも呼べる（durationはnow基準。欠測はnull） */
export function buildGoalSummary(
  root: string,
  goalId: string,
  opts?: { score?: number | null; now?: string },
): Extract<HistoryEvent, { type: "goal_summary" }> {
  const now = opts?.now ?? new Date().toISOString();
  let title = "(unknown)";
  let startTs: string | null = null;
  let entryRoute: EntryRoute = "full";
  let entrySeen = false;
  let routerRoute: RouterRoute | null = null;
  let diffLines: number | null = null;
  let lenses: VerifierLens[] = [];
  let verdictLevel: VerdictLevel | null = null;
  let verdictTarget: DriftTarget | null = null;
  let maxFail = 0;
  let escalated = false;
  let criticLevel: VerdictLevel | null = null;
  let rewinds = 0;
  let verifierRounds = 0;
  for (const h of readHistory(root)) {
    if ((h as { goal?: unknown }).goal !== goalId) continue;
    switch (h.type) {
      case "goal_start":
        if (startTs === null) {
          startTs = h.ts ?? null;
          title = h.title;
        }
        break;
      case "entry_route":
        if (!entrySeen) {
          // 旧A/B/C行は新名に正規化（disk不変・read時変換）
          entryRoute = normalizeEntryRoute(h.route) ?? "full";
          entrySeen = true;
        }
        break;
      case "router_check":
        routerRoute = h.route;
        diffLines = h.diff_lines;
        break;
      case "verifier_verdict":
        lenses = h.lens;
        verdictLevel = h.level;
        verdictTarget = h.target;
        verifierRounds += 1;
        break;
      case "attempt":
      case "eval_run":
        if (h.fail_streak > maxFail) maxFail = h.fail_streak;
        break;
      case "escalated":
        escalated = true;
        break;
      case "critic_review_set":
        criticLevel = h.level;
        break;
      case "phase":
        if (h.from === "polish" && h.to === "implementing") rewinds += 1;
        break;
      default:
        break;
    }
  }
  const duration =
    startTs === null ? NaN : (Date.parse(now) - Date.parse(startTs)) / 1000;
  return {
    type: "goal_summary",
    goal: goalId,
    title,
    duration_s:
      Number.isNaN(duration) || duration < 0 ? null : Math.round(duration),
    entry_route: entryRoute,
    router_route: routerRoute,
    diff_lines: diffLines,
    lenses,
    verdict_level: verdictLevel,
    verdict_target: verdictTarget,
    max_fail_streak: maxFail,
    escalated,
    critic_level: criticLevel,
    rewinds,
    verifier_rounds: verifierRounds,
    score: opts?.score ?? null,
  };
}

/* 改善ループ（reflect）の入力となるgoal行集計。
 * goal_summary行を返し、欠落分（既存complete＝backfill兼用）はhistoryから再合成する */
export function buildTelemetry(root: string): GoalSummaryRecord[] {
  const summaries = new Map<string, GoalSummaryRecord>();
  const completed = new Map<string, { score: number | null; ts?: string }>();
  for (const h of readHistory(root)) {
    const g = (h as { goal?: unknown }).goal;
    if (typeof g !== "string") continue;
    if (h.type === "goal_summary") summaries.set(g, h);
    else if (h.type === "goal_complete" && !completed.has(g)) {
      completed.set(g, {
        score: (h as { score?: number | null }).score ?? null,
        ts: h.ts,
      });
    }
  }
  const out = [...summaries.values()];
  for (const [g, c] of completed) {
    // backfill再合成はgoal_completeのtsをnowに使う（クエリ時刻依存の不安定値を避ける）
    if (!summaries.has(g))
      out.push(buildGoalSummary(root, g, { score: c.score, now: c.ts }));
  }
  out.sort((a, b) => (a.goal < b.goal ? -1 : a.goal > b.goal ? 1 : 0));
  return out;
}

/** clear 専用: goal を done 化するが `goal_complete` イベントは記録しない
 * （clear は完了ではなく破棄のため、監査ログに完了として残さない）。
 * done 化自体（status/done_at）は維持し、`active` からは外す。
 * loop カウンタは0に戻し、phase は designing に戻す（phase イベントも記録しない）。 */
export function clearActiveGoal(root: string): Goal | null {
  const goals = readGoals(root);
  if (!goals.active) return null;
  const goal = goals.goals.find((g) => g.id === goals.active);
  if (!goal) return null;
  goal.status = "done";
  goal.done_at = new Date().toISOString();
  goals.active = null;
  writeGoals(root, goals);
  // diff退避を掃除（completeGoalと同型）
  removeStashedDiff(root, goal.id);
  const s = readState(root);
  writeState(root, {
    ...s,
    phase: "designing",
    notes: "",
    fail_streak: 0,
    loop_streak: 0,
    loop_stopped: false,
    loop_stop_count: 0,
  });
  return goal;
}

/** clear 専用の loop 全リセット（completeGoal はカウンタを保持するので分離） */
export function resetLoopForClear(root: string): void {
  const state = readState(root);
  writeState(root, {
    ...state,
    loop_streak: 0,
    loop_stopped: false,
    loop_stop_count: 0,
  });
}

export interface PendingRoute {
  route: EntryRoute;
  reason?: string;
  at: string;
}

function pendingRoutePath(root: string): string {
  return join(dir(root), "pending_route.json");
}

/** route_set先行の一時置き場（goal start時に消費・削除。再起動耐性のためstate外ファイル） */
export function writePendingRoute(root: string, route: EntryRoute, reason?: string): void {
  try {
    mkdirSync(dir(root), { recursive: true });
    writeFileSync(
      pendingRoutePath(root),
      JSON.stringify({ route, reason, at: new Date().toISOString() }),
      "utf8",
    );
  } catch {
    // 書けなければpending無し扱い（→A）。軽さ優先で黙殺
  }
}

export function readPendingRoute(root: string): PendingRoute | null {
  try {
    const raw = readFileSync(pendingRoutePath(root), "utf8");
    const p = JSON.parse(raw) as Partial<PendingRoute>;
    // 旧A/B/Cも受理し新名に正規化（history互換）。directは消費側で除外する
    const route = normalizeEntryRoute(p.route);
    if (!route) return null;
    return { route, reason: p.reason, at: String(p.at ?? "") };
  } catch {
    return null;
  }
}

export function clearPendingRoute(root: string): void {
  try {
    unlinkSync(pendingRoutePath(root));
  } catch {
    // 存在しなければ何もしない
  }
}

/** route_set→goal先行の救済: entry未記録のactive goalに直接bindする。
 * 記録済み・goal無し・非active（done/paused）・directはnull（pendingのみ残る／directはhistoryのみ）。
 * done＋nullにbindするとpendingが消えて次回startが欠測になる（live実証済み）ため塞ぐ。
 * pausedも塞ぐ（resumeがentry_routeを復元しない既存穴と複合するため） */
export function bindEntryRoute(
  root: string,
  route: EntryRoute,
  reason?: string,
): ActiveLoop | null {
  const active = getActive(root);
  if (!active || active.goal.status !== "active" || active.state.entry_route) return null;
  if (route === "direct") return null;
  const r = mutateActive(root, () => ({ state: { entry_route: route } }));
  if (r) {
    recordEvent(root, {
      type: "entry_route",
      goal: r.goal.id,
      route,
      reason,
    });
  }
  return r;
}

/* light/advised→full昇格（ラチェット）。full→light・null→lightは拒否。
 * 実効: entry_route=full＋escalated_at＋phaseをdesigningに戻す（design肉付け＋critic1回＋
 * fan-outのため。LEGAL_TRANSITIONSの昇格専用経路を使う）。direct・oracle・goal無しはnull */
export function escalateEntryRoute(root: string): ActiveLoop | null {
  const active = getActive(root);
  if (!active) return null;
  const from = active.state.entry_route;
  if (from !== "light" && from !== "advised") return null;
  const r = mutateActive(root, () => ({
    state: {
      entry_route: "full" as EntryRoute,
      escalated_at: new Date().toISOString(),
      phase: "designing" as Phase,
      ...phaseResetFields(),
      last_verifier: null,
    },
  }));
  if (r) {
    recordEvent(root, {
      type: "escalated",
      goal: r.goal.id,
      from,
      at: r.state.escalated_at ?? "",
    });
  }
  return r;
}

/* 遷移合法性表（takt workflow doctorの発想の機械版）。
 * - 同一phaseは許可（notes更新等の無遷移呼び出しのため）
 * - polish→implementingのみ巻き戻し可（verifier driftの行き先）
 * - implementing/polish→designingはlight/advised→full昇格専用経路（escalateEntryRoute経由。
 *   濫用時はhistoryのentry_route/escalated/escalated_atで監査可）
 * - *→doneは不可: doneはcompleteGoal（verifier cleanガード付き）のみ。
 *   clearActiveGoalはstate直書きのためこの表の対象外 */
export const LEGAL_TRANSITIONS: Record<Phase, Phase[]> = {
  designing: ["designing", "implementing"],
  implementing: ["implementing", "polish", "designing"],
  polish: ["polish", "implementing", "done", "designing"],
  done: ["done"],
};

export function isLegalPhaseTransition(from: Phase, to: Phase): boolean {
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

/* phase遷移時のカウンタリセット集合（setPhaseとescalateEntryRouteで共有。
 * 巻き戻し直後のstuck早期発火・fail引き継ぎを防ぐ） */
function phaseResetFields(): Partial<LoopState> {
  return {
    fail_streak: 0,
    edit_file: null,
    edit_streak: 0,
    last_diff_lines: null,
    diff_stall: 0,
    last_stuck_reasons: [],
  };
}

export function setPhase(
  root: string,
  phase: Phase,
  notes?: string,
): ActiveLoop | null {
  if (!PHASES.includes(phase)) return null;
  const before = getActive(root);
  // 遷移合法性（takt workflow doctorの発想の機械版）。
  // 特に *→done の直指定を塞ぐ: doneはcomplete（verifier cleanガード付き）のみ。
  // setPhase(done)で抜けるとgoalがactiveのままloopだけ止まるself-graded doneの穴になる。
  if (before && !isLegalPhaseTransition(before.state.phase, phase)) return null;
  const r = mutateActive(root, () => ({
    // phaseが変わるたびfail系・stuck系カウンタをリセット
    // （implementingに戻ってきた時も0から数え直す。巻き戻し直後のインフレ防止）
    state: {
      phase,
      ...phaseResetFields(),
      ...(notes !== undefined ? { notes } : {}),
    },
  }));
  if (r && before && before.state.phase !== phase) {
    recordEvent(root, {
      type: "phase",
      goal: r.goal.id,
      from: before.state.phase,
      to: phase,
      ...(notes ? { notes } : {}),
    });
  }
  return r;
}

export function unbindSession(root: string, sessionID: string): void {
  const state = readState(root);
  if (state.session_id !== sessionID) return;
  writeState(root, { ...state, session_id: null });
}

/* ================================================================== *
 * router gate（loop-driver.sh 相当）: diff サイズを機械測定して分岐
 * ================================================================== */
import type { PluginInput } from "@opencode-ai/plugin";
type Shell = PluginInput["$"];

/** baseline_rev を VCS から取得（jj → git → null） */
export async function captureBaselineRev(
  shell: Shell,
  root: string,
): Promise<string | null> {
  try {
    const r =
      await shell`sh -c ${"jj log -r 'heads() & ~empty()' -T commit_id --no-graph --limit 1"}`
        .cwd(root)
        .nothrow()
        .quiet();
    const out = r.stdout.toString().trim();
    if (r.exitCode === 0 && out) {
      const rev = out.split("\n")[0] ?? null;
      if (rev && isValidBaselineRev(rev)) return rev;
      return null;
    }
  } catch {
    // ignore
  }
  try {
    const r = await shell`sh -c ${"git rev-parse HEAD"}`
      .cwd(root)
      .nothrow()
      .quiet();
    const out = r.stdout.toString().trim();
    if (r.exitCode === 0 && out && isValidBaselineRev(out)) return out;
  } catch {
    // ignore
  }
  return null;
}

/** baseline_rev の形式検証（jj commit_id / git sha は共に full hex）。
 * VCS由来とはいえ shell 補間に渡す前に検証し、不正なら null 扱いにする。 */
export function isValidBaselineRev(baseline: string): boolean {
  return /^[0-9a-fA-F]+$/.test(baseline);
}

/** deep検知の対象（状態遷移核）。repo相対・正規化済みパスで照合する。
 * 他repoでは一致せずfail-open（deepなし）。判断はstate/gateに閉じる——
 * index/mcpに判断を足したらRISKを見直すこと（不変条件） */
export const RISK_PATHS: readonly string[] = ["src/state.ts", "src/gate.ts"];

/** baseline からの変更ファイル列を測定する（jj → git fallback）。
 * deep検知用。取得不能時は []（fail-open＝deepなし）。 */
export async function measureChangedFiles(
  shell: Shell,
  root: string,
  baseline: string | null,
): Promise<string[]> {
  if (!baseline || !isValidBaselineRev(baseline)) return [];
  const collect = (out: string): string[] =>
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  try {
    const r = await shell`jj diff --from ${baseline} --name-only`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) return collect(r.stdout.toString());
  } catch {
    // ignore → gitへ
  }
  try {
    const r = await shell`git diff --name-only ${baseline}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) return collect(r.stdout.toString());
  } catch {
    return [];
  }
  return [];
}

/** deep判定＝(現行集合 − 初期集合) ∩ RISK_PATHS（effectiveDiffLinesのファイル版。
 * 前goal残骸を除外する）。初期集合null（legacy）時はfalse（帰属不能のため）。 */
export function detectDeepRisk(
  root: string,
  currentFiles: string[],
  initialFiles: string[] | null | undefined,
): { deep: boolean; reason: string | null } {
  if (!initialFiles) return { deep: false, reason: null };
  const initial = new Set(initialFiles.map((f) => normalizeForGate(root, f)));
  const touched = currentFiles
    .map((f) => normalizeForGate(root, f))
    .filter((f) => !initial.has(f) && (RISK_PATHS as readonly string[]).includes(f));
  if (touched.length === 0) return { deep: false, reason: null };
  return { deep: true, reason: `risk files touched: ${touched.join(", ")}` };
}

/** `--stat` / `--shortstat` 末行（"N files changed, M insertions(+), K deletions(-)"）
 * をパースして挿入+削除行数を返す。insert-only / delete-only 対応。
 * どちらも無ければ null（diff無しとパース不能を区別せず、呼び出し側で0扱い）。 */
export function parseDiffShortstat(out: string): number | null {
  const ins = out.match(/(\d+) insertion/);
  const del = out.match(/(\d+) deletion/);
  if (!ins && !del) return null;
  return (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0);
}

/** baseline からの diff 行数を測定する（jj → git fallback） */
export async function measureDiffLines(
  shell: Shell,
  root: string,
  baseline: string | null,
): Promise<number> {
  if (!baseline || !isValidBaselineRev(baseline)) return 0;
  try {
    // Bun shell の補間値は自動escapeされるため、baseline を直接埋め込む。
    // 以前の `sh -c "jj diff --from ${baseline} ..."` は sh 内で無escapeだった。
    // pipe (tail) を避け、末行の取り出しは JS で行う。
    const r = await shell`jj diff --from ${baseline} --stat`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) {
      const lines = r.stdout.toString().trim().split("\n");
      const parsed = parseDiffShortstat(lines[lines.length - 1] ?? "");
      if (parsed !== null) return parsed;
    }
  } catch {
    // ignore
  }
  try {
    const r = await shell`git diff --shortstat ${baseline}`
      .cwd(root)
      .nothrow()
      .quiet();
    const out = r.stdout.toString().trim();
    return parseDiffShortstat(out) ?? 0;
  } catch {
    return 0;
  }
}

export interface StashedDiff {
  path: string;
  lines: number;
  baseline: string;
}

/* 実効diff＝測定－初期脏れ（floor 0）。前goalの未コミット分を自goalの実装と
 * 誤認しないための減算。legacy（null）→0扱いで旧挙動維持 */
export function effectiveDiffLines(
  measured: number,
  initial: number | null | undefined,
): number {
  return Math.max(0, measured - (initial ?? 0));
}

/* goal start直後の初期脏れsnapshot（tool層・asyncから呼ぶ。startGoalはsyncのため
 * 測定できない）。designing中はsource編集不可のためstart時測定で安定。
 * rev取得失敗時は書かない（null＝legacy扱い）。mid-designingの手動commitによる
 * ずれは許容（稀・方向は安全側に倒れないが監査可） */
export function snapshotInitialDirt(root: string, lines: number | null): void {
  if (lines === null || lines < 0) return;
  const state = readState(root);
  writeState(root, { ...state, initial_diff_lines: lines });
}

/* goal start直後の初期脏れファイル集合snapshot（行数のsnapshotInitialDirt同型。
 * deep判定の差分基準。nullは書かない（legacy＝deepなし扱いを維持） */
export function snapshotInitialDiffFiles(
  root: string,
  files: string[] | null,
): void {
  if (!files) return;
  const state = readState(root);
  writeState(root, {
    ...state,
    initial_diff_files: files.map((f) => normalizeForGate(root, f)),
  });
}

/** 退避diffのpath（stashDiffと単一源泉。complete/clear時の掃除と共有）。
 * 子セッションのexternal_directory権限で読めるようrepo内（gitignore済み）に置く。
 * /tmpは子から読めない実証済みのため使わない */
export function stashedDiffPath(root: string, goalId: string): string {
  return join(dir(root), "tmp", `gh-verify-${goalId}.txt`);
}

/** 退避diffの掃除。存在しなくても成功（best-effort。complete/clear時） */
export function removeStashedDiff(root: string, goalId: string): void {
  if (!/^g-[0-9a-z]+$/.test(goalId)) return;
  try {
    unlinkSync(stashedDiffPath(root, goalId));
  } catch {
    // 存在しない・権限なし等は無視
  }
}

/** 単一ファイルのdiffを取得する（stashDiffの実効diff用）。
 * 失敗時は null（呼び出し側が全文退避に倒す）。 */
export async function diffOneFile(
  shell: Shell,
  root: string,
  baseline: string,
  file: string,
): Promise<string | null> {
  try {
    const r = await shell`jj diff --from ${baseline} -- ${file}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) return r.stdout.toString();
  } catch {
    // gitへ
  }
  try {
    const r = await shell`git diff ${baseline} -- ${file}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) return r.stdout.toString();
  } catch {
    return null;
  }
  return null;
}

/* verifier fan-out用のdiff退避: 実効diff（初期脏れ除外）を1回だけ取得し、
 * repo内（.graphhopper/tmp）に置いてpathで渡す（3 lensへのinline 3重展開を防ぐ。
 * /tmpは子権限で読めないため使わない。ファイル名にgoalを含め並列goalの衝突を避ける）。
 * 初期集合null（legacy）・測定不能時は全文退避に倒す（fail-safe＝読み過ぎ側）。
 * 失敗時は null */
export async function stashDiff(
  shell: Shell,
  root: string,
  baseline: string | null,
  goalId: string,
): Promise<StashedDiff | null> {
  if (!baseline || !isValidBaselineRev(baseline)) return null;
  if (!/^g-[0-9a-z]+$/.test(goalId)) return null;
  const path = stashedDiffPath(root, goalId);
  const write = (out: string): StashedDiff => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, out, "utf8");
    return {
      path,
      lines: out.length === 0 ? 0 : out.split("\n").length,
      baseline,
    };
  };
  // 実効diff: 現行集合−初期集合の対象ファイルのみ退避する
  const initial = getActive(root)?.state.initial_diff_files;
  if (initial) {
    let current: string[] = [];
    try {
      current = await measureChangedFiles(shell, root, baseline);
    } catch {
      current = [];
    }
    if (current.length > 0) {
      const initialSet = new Set(
        initial.map((f) => normalizeForGate(root, f)),
      );
      const effective = [
        ...new Set(current.map((f) => normalizeForGate(root, f))),
      ].filter((f) => !initialSet.has(f));
      if (effective.length === 0) return write("");
      try {
        const parts: string[] = [];
        for (const f of effective) {
          const part = await diffOneFile(shell, root, baseline, f);
          if (part === null) throw new Error(`per-file diff failed: ${f}`);
          parts.push(part);
        }
        return write(parts.join("\n"));
      } catch {
        // 下の全文退避へ（読み過ぎ側に倒す）
      }
    }
  }
  try {
    const r = await shell`jj diff --from ${baseline}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) return write(r.stdout.toString());
  } catch {
    // git にフォールバック
  }
  try {
    const r = await shell`git diff ${baseline}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) return write(r.stdout.toString());
  } catch {
    return null;
  }
  return null;
}

export function recordRouterCheck(
  root: string,
  baseline: string | null,
  diffLines: number,
  route: RouterRoute,
  deep?: { deep: boolean; reason: string | null },
): LoopState {
  const state = readState(root);
  const next: LoopState = {
    ...state,
    router: {
      baseline_rev: baseline,
      diff_lines: diffLines,
      route,
      checked_at: new Date().toISOString(),
      deep: deep?.deep ?? false,
      deep_reason: deep?.reason ?? null,
    },
  };
  writeState(root, next);
  if (state.goal_id)
    recordEvent(root, {
      type: "router_check",
      goal: state.goal_id,
      diff_lines: diffLines,
      route,
      deep: next.router.deep,
      deep_reason: next.router.deep_reason,
    });
  return next;
}

/** router記録のchoke point（検知＋記録）。既存のrecordRouterCheck呼出は
 * こちらに置換する（eval経路含む。deep検知の抜けを作らない）。 */
export async function recordRouterCheckWithRisk(
  shell: Shell,
  root: string,
  baseline: string | null,
  diffLines: number,
  route: RouterRoute,
): Promise<LoopState> {
  const active = getActive(root);
  // measureChangedFiles は内部で例外を握り潰し [] を返すためここではthrowしない
  const files = await measureChangedFiles(shell, root, baseline);
  const { deep, reason } = detectDeepRisk(
    root,
    files,
    active?.state.initial_diff_files ?? null,
  );
  return recordRouterCheck(root, baseline, diffLines, route, { deep, reason });
}

/** verifier fan-out の1レンズ分の結果（verifier_set の results 要素）。
 * model は per-lens上書き（deep時の上位モデル等）。省略時はトップレベルmodel→config既定。
 * 申告値であり実在は検証しない（critic_set／consult_set同型の既知トレードオフ） */
export interface VerifierResult {
  lens: VerifierLens;
  level: VerdictLevel;
  target?: DriftTarget | null;
  model?: string | null;
}

/** verifier_set 入力の検証。通れば null、ダメならエラー文（tool がそのまま返す）。
 * self-graded 完了防止の機械ゲート（旧 lens 空拒否の後継）。
 * opts.entryRoute: light/advised非昇格はgeneral×1のみ可、昇格後は3lens必須。
 * null/full/oracleは現行通り（legacy互換・fullはprose＋router運用）。 */
export function checkVerifierResults(
  results: VerifierResult[] | null | undefined,
  opts?: { entryRoute?: EntryRoute | null; escalated?: boolean },
): string | null {
  if (!Array.isArray(results) || results.length === 0) {
    return "error: results が空です。graphhopper_verifier_set は task(subagent_type: 'graphhopper-verifier') を実際に呼んだ後にしか記録できません（self-graded完了を防ぐための機械的ゲート）。route=advisorでも最低1回、'general'charterで呼んでください。";
  }
  const known: VerifierLens[] = [
    "requirement",
    "behavior",
    "progress",
    "general",
  ];
  const seen = new Set<string>();
  for (const r of results) {
    if (!r || typeof r !== "object") return "error: results の要素が不正です";
    if (!known.includes(r.lens)) {
      return `error: 未知の lens です: ${String((r as { lens?: unknown }).lens)}`;
    }
    if (seen.has(r.lens)) {
      return `error: lens が重複しています: ${r.lens}`;
    }
    seen.add(r.lens);
    if (r.level !== "clean" && r.level !== "drift") {
      return `error: 不正な level です: ${String((r as { level?: unknown }).level)}`;
    }
    if (
      r.target !== undefined &&
      r.target !== null &&
      r.target !== "implementing" &&
      r.target !== "design" &&
      r.target !== "requirements"
    ) {
      return `error: 不正な target です: ${String(r.target)}`;
    }
    if (r.level === "drift" && !r.target) {
      return `error: drift には target が必要です (lens: ${r.lens})`;
    }
    if (
      r.model !== undefined &&
      r.model !== null &&
      (typeof r.model !== "string" || r.model.trim().length === 0)
    ) {
      return `error: 不正な model です (lens: ${r.lens})`;
    }
  }
  // entry route×lens照合（light/advised非昇格はgeneral×1のみ、昇格後は3lens必須。
  // 昇格後はentry_route自体がfullに戻るためescalated旗で判定する。
  // null/full/oracle非昇格は現行通り＝legacy互換・fullはprose＋router運用）
  if (opts?.escalated) {
    if (
      !seen.has("requirement") ||
      !seen.has("behavior") ||
      !seen.has("progress")
    ) {
      return "error: 昇格後（light/advised→full）の verifier は requirement/behavior/progress の3lens必須";
    }
  } else if (opts?.entryRoute === "light" || opts?.entryRoute === "advised") {
    const lenses = [...seen];
    if (lenses.length !== 1 || lenses[0] !== "general") {
      return "error: entry_route=light/advised（非昇格）の verifier は general×1 のみ可。fan-outが必要なら graphhopper_escalate でfullへ昇格してから3lensで記録せよ";
    }
  }
  return null;
}

/** verifier fan-out 結果の集約ルール（純粋関数）。
 * 前提: checkVerifierResults で検証済み（非空・既知lens・重複なし・
 * drift に target 必須）。「confidence高 & severity high/critical のみ採用」
 * というメインの裁量だった基準をコード化したもの:
 * - 1つでも drift → 全体 drift。target は `implementing` を優先
 *   （即時巻き戻し可能な唯一の行き先）、無ければ先頭の drift target。
 * - 全 clean → clean (target null)。 */
export function aggregateVerdicts(results: VerifierResult[]): {
  level: VerdictLevel;
  target: DriftTarget | null;
} {
  const drifts = results.filter((r) => r.level === "drift");
  if (drifts.length === 0) return { level: "clean", target: null };
  const impl = drifts.find((r) => r.target === "implementing");
  return {
    level: "drift",
    target: (impl ?? drifts[0])?.target ?? null,
  };
}

export function setVerifierVerdict(
  root: string,
  verdict: Omit<VerifierVerdict, "at">,
): LoopState {
  const state = readState(root);
  const model =
    verdict.model ?? readConfig(root).agents["graphhopper-verifier"] ?? null;
  // lens並列モデルを lens 長に揃える（不足は既定でpad、過剰はtruncate。fail-safe）
  const models = verdict.lens.map(
    (_, i) => verdict.models?.[i] ?? model,
  );
  const next: LoopState = {
    ...state,
    last_verifier: { ...verdict, model, models, at: new Date().toISOString() },
  };
  writeState(root, next);
  if (state.goal_id) {
    recordEvent(root, {
      type: "verifier_verdict",
      goal: state.goal_id,
      level: verdict.level,
      target: verdict.target,
      lens: verdict.lens,
      model,
      models,
    });
  }
  return next;
}

/** status表示用：既定と異なるlensのみ `lens@model` 式で列挙する（差分表示）。
 * 全一致・欠測時は ""（行自体は呼び出し側で省略可）。 */
export function formatLensModels(
  lens: VerifierLens[],
  models: (string | null)[] | undefined,
  fallback: string | null | undefined,
): string {
  if (!models) return "";
  return lens
    .map((l, i) => {
      const m = models[i] ?? fallback ?? null;
      return m && m !== fallback ? `${l}@${m}` : null;
    })
    .filter((x): x is string => x !== null)
    .join(",");
}

/** design.md質レビュー（graphhopper-critic）の結果を記録する。opt-inでありphase遷移の
 * 前提条件にはしない（verifier_setのlens空拒否のようなself-graded防止機構は付けない）。 */
export function setCriticVerdict(
  root: string,
  verdict: Omit<CriticVerdict, "at">,
): LoopState {
  const state = readState(root);
  const model =
    verdict.model ?? readConfig(root).agents["graphhopper-critic"] ?? null;
  const next: LoopState = {
    ...state,
    critic_review: { ...verdict, model, at: new Date().toISOString() },
  };
  writeState(root, next);
  if (state.goal_id) {
    recordEvent(root, {
      type: "critic_review_set",
      goal: state.goal_id,
      level: verdict.level,
      model,
    });
  }
  return next;
}

/** entry相談（graphhopper-advisor／graphhopper-oracle）の記録。存在記録であり
 * 相談の実在は検証しない（critic_setと同型の既知トレードオフ）。
 * designing→implementingの機械ゲート（checkPhaseMove）の入力になる。 */
export function setConsult(
  root: string,
  kind: ConsultKind,
  consult: Omit<ConsultRecord, "at">,
): LoopState {
  const state = readState(root);
  const agentKey =
    kind === "advisor" ? "graphhopper-advisor" : "graphhopper-oracle";
  const model = consult.model ?? readConfig(root).agents[agentKey] ?? null;
  const record: ConsultRecord = {
    ...consult,
    model,
    at: new Date().toISOString(),
  };
  const next: LoopState = {
    ...state,
    ...(kind === "advisor"
      ? { advisor_consult: record }
      : { oracle_consult: record }),
  };
  writeState(root, next);
  if (state.goal_id) {
    recordEvent(root, {
      type: "consult_set",
      goal: state.goal_id,
      kind,
      model,
    });
  }
  return next;
}

/* ================================================================== *
 * 無限ループ検知（echoループ + 同一tool call反復）: assistant出力がそのまま次の
 * user入力にミラーされ続けると、session.idle が連続発火して自動継続が延々回る。
 * 検知は2種:
 * - echo: 直前のassistantメッセージとほぼ同一のuserメッセージ（3パターン）
 * - tool: 直近ウィンドウ内で同一 (tool名+入力ハッシュ) の反復
 * どちらかが loop_stop_threshold（echo無効時は loop_tool_repeat_threshold）回
 * 連続したら自動継続を止める（goalをpause）。
 * ================================================================== */

/** 検知の種別。イベント記録・通知文に使う */
export type LoopKind = "echo" | "tool" | "echo+tool";

/** session.messages() の最小構造（SDK型に依存しない軽量型） */
export interface SessionMessageLike {
  info: { id: string; role: "user" | "assistant" };
  parts: Array<{
    type: string;
    text?: string;
    synthetic?: boolean;
    callID?: string;
    tool?: string;
    state?: { status?: string; input?: unknown };
  }>;
}

function normalizeMessage(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/\s+/g, "") // 空白・改行を除去
      .replace(/[。、！!？?・…〜〜：:，,（）()「」『』'"'`~]/g, "") // 句読点を除去
      // 絵文字・記号・ASCII装飾を除去（echo判定のノイズ）
      .replace(/[^\u3040-\u30ff\u4e00-\u9fff\u0020-\u007e\u30fc]/g, "")
      .trim()
  );
}

/** echoループ検知。3パターンを扱う:
 * 1. 末尾=user・直前=assistant がほぼ同一（外部ミラーが出力を user にコピーするケース）
 * 2. 末尾=assistant・直前=user で、その user が「その前の assistant（[-3]）」の echo
 *    （自動継続ループで idle 時点の末尾が必ず assistant になるケースの本体）
 * 3. 連続する assistant メッセージ（[-3] と [-1]）がほぼ同一（強制継続で同文を繰り返す）
 * どれも正規化テキストの同一 or 十分な重複を echo とみなす。 */
export function isEchoMessage(msgs: SessionMessageLike[]): boolean {
  if (msgs.length < 2) return false;
  const last = msgs[msgs.length - 1];
  const prev = msgs[msgs.length - 2];

  const text = (m: SessionMessageLike): string =>
    (m.parts ?? [])
      .filter((p) => p.type === "text" && !p.synthetic)
      .map((p) => p.text ?? "")
      .join("");

  const isEcho = (a: string, b: string): boolean => {
    const x = normalizeMessage(a);
    const y = normalizeMessage(b);
    if (!x || !y) return false;
    // 短すぎる挨拶（"👋" など）は echo と誤判定しない
    if (Math.min(x.length, y.length) < 4) return false;
    if (x === y) return true;
    // 部分一致（一方が他方にほぼ含まれる）。例: 編集で微差が付いた場合
    const short = x.length <= y.length ? x : y;
    const long = x.length <= y.length ? y : x;
    if (long.includes(short)) return short.length >= long.length * 0.5;
    return false;
  };

  // パターン1: 末尾=user・直前=assistant のミラー echo
  if (last.info.role === "user" && prev.info.role === "assistant") {
    return isEcho(text(prev), text(last));
  }

  // パターン2/3: 末尾=assistant（自動継続ループはこちらの形）
  if (last.info.role === "assistant" && msgs.length >= 3) {
    const beforePrev = msgs[msgs.length - 3];
    // 直前の user がその前の assistant の echo になっている
    if (prev.info.role === "user" && beforePrev.info.role === "assistant") {
      if (isEcho(text(beforePrev), text(prev))) return true;
    }
    // 直前の assistant と末尾の assistant が同一文の繰り返し
    if (beforePrev.info.role === "assistant") {
      if (isEcho(text(beforePrev), text(last))) return true;
    }
  }
  return false;
}

export interface LoopDetectionResult {
  streak: number;
  stopped: boolean;
  justStopped: boolean;
}

/* ---------------------------------------------------------------- *
 * 同一tool call反復検知: 最後の人間user入力以降の tool call のうち、直近
 * loop_tool_window 件で同一 (tool名+入力ハッシュ) が loop_tool_repeat_threshold 回
 * 出たらループとみなす。callID で dedupe、completed/error のみ数える。
 * ---------------------------------------------------------------- */

/** JSONのcanonical形式（キーを再帰ソート）。入力の同一性を順序非依存で判定する。
 * stringify不能な入力（undefined / function / symbol）は "undefined" を返す。 */
export function canonicalJSON(input: unknown): string {
  if (input === null || typeof input !== "object") {
    const s = JSON.stringify(input);
    return s === undefined ? "undefined" : s;
  }
  if (Array.isArray(input)) {
    return "[" + input.map((v) => canonicalJSON(v)).join(",") + "]";
  }
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") +
    "}"
  );
}

/** FNV-1a 64bit ハッシュ（文字列→16進hex）。実用目的のハッシュで十分 */
export function fnv1a(input: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

/** tool call を `tool名:hash(canonicalJSON(input))` に正規化する。
 * シリアライズ不能・callID欠損・input欠損の tool 部品は null（カウント対象外）。 */
export function toolCallHash(part: SessionMessageLike["parts"][number]): string | null {
  if (part.type !== "tool") return null;
  if (!part.callID || !part.tool || !part.state || !("input" in part.state)) {
    return null;
  }
  if (part.state.status !== "completed" && part.state.status !== "error") {
    return null; // pending / running は数えない
  }
  try {
    return `${part.tool}:${fnv1a(canonicalJSON(part.state.input))}`;
  } catch {
    return null;
  }
}

/** 自動継続注入メッセージの先頭マーカー。session.messages 上で人間入力と
 * 区別するための目印（index.ts の idle ハンドラが注入文の先頭に付与する）。
 * これが無いと自前の注入が「人間の新規入力」に見えて tool 反復検知の
 * ウィンドウが毎回リセットされ、tool ループを検知できなくなる。 */
export const CONTINUATION_MARKER = "[graphhopper-continuation]";

/** 人間の新規入力テキスト部品か。自動継続注入・synthetic は除外する */
export function isHumanTextPart(
  p: SessionMessageLike["parts"][number],
): boolean {
  if (p.type !== "text" || p.synthetic || !(p.text ?? "").length) return false;
  return !p.text!.startsWith(CONTINUATION_MARKER);
}

/** 同一tool call反復を検知する。callID重複は1件に数え直す。 */
export function isToolRepeatLoop(
  msgs: SessionMessageLike[],
  cfg: GraphhopperConfig,
): boolean {
  const window = cfg.loop_tool_window;
  const threshold = cfg.loop_tool_repeat_threshold;
  if (window <= 0 || threshold <= 1) return false;

  // 最後の「人間の新規user入力（自動継続注入・syntheticでない text 部品を持つ）」
  // 以降のメッセージだけを見る。
  // tool result を運ぶ user メッセージ（text 部品なし）は人間入力扱いしない
  // （自動継続バーストを切らない）。自前の継続注入（CONTINUATION_MARKER 付き）も
  // 人間入力扱いしない（注入のたびにウィンドウがリセットされ tool ループを
  // 検知できなくなるバグの修正）。
  let lastHumanIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const hasHumanText = (m.parts ?? []).some(
      (p) => m.info.role === "user" && isHumanTextPart(p),
    );
    if (hasHumanText) {
      lastHumanIdx = i;
      break;
    }
  }

  // callID で dedupe（最新状態を採用）
  const calls = new Map<string, string>();
  for (let i = lastHumanIdx + 1; i < msgs.length; i++) {
    for (const p of msgs[i]?.parts ?? []) {
      if (p.type !== "tool" || !p.callID) continue;
      const h = toolCallHash(p);
      if (h === null) continue;
      calls.set(p.callID, h);
    }
  }

  const recent = Array.from(calls.values()).slice(-window);
  if (recent.length < threshold) return false;

  const counts = new Map<string, number>();
  for (const h of recent) counts.set(h, (counts.get(h) ?? 0) + 1);
  for (const n of counts.values()) if (n >= threshold) return true;
  return false;
}

/** echo / tool のどちらが検知に寄与したかを判定する（両方なら "echo+tool"） */
export function detectLoopKind(
  msgs: SessionMessageLike[],
  cfg: GraphhopperConfig,
): { detected: boolean; kind: LoopKind } {
  const echoEnabled = cfg.loop_stop_threshold > 0;
  const toolEnabled = cfg.loop_tool_repeat_threshold > 1;
  if (!echoEnabled && !toolEnabled) return { detected: false, kind: "echo" };

  const isEcho = echoEnabled && isEchoMessage(msgs);
  const isTool = toolEnabled && isToolRepeatLoop(msgs, cfg);
  const kind: LoopKind = isEcho && isTool ? "echo+tool" : isEcho ? "echo" : "tool";
  return { detected: isEcho || isTool, kind };
}

/** ループ検知で loop_streak / loop_stopped を更新する。検知でない（人間の新規入力）なら
 * streakをリセットし、停止中でも再開する（検知による誤検知でgoalが永久停止しないため）。
 * 閾値に達したら loop_stopped=true を返す（呼び出し側が goal を pause する）。 */
export function updateLoopDetection(
  root: string,
  detected: boolean,
  kind: LoopKind = "echo",
): LoopDetectionResult {
  const cfg = readConfig(root);
  const threshold =
    cfg.loop_stop_threshold > 0
      ? cfg.loop_stop_threshold
      : cfg.loop_tool_repeat_threshold;
  const state = readState(root);

  let streak: number;
  let stopped: boolean;
  if (threshold > 0 && detected) {
    streak = state.loop_streak + 1;
    stopped = state.loop_stopped || streak >= threshold;
  } else {
    streak = 0;
    stopped = false;
  }

  writeState(root, { ...state, loop_streak: streak, loop_stopped: stopped });
  if (state.goal_id && streak > 0) {
    recordEvent(root, {
      type: "loop_detected",
      goal: state.goal_id,
      kind,
      streak,
      stopped,
    });
  }
  return { streak, stopped, justStopped: stopped && !state.loop_stopped };
}

/* ---------------------------------------------------------------- *
 * 継続注入 dedupe: 前回注入以降の「進展」をフィンガープリント化する。
 * 進展 = 人間入力の到達位置・tool 実行件数・phase・eval_cmd・直近 eval 結果。
 * assistant の言い換え待機 ack（テキストのみ・tool なし）は進展に数えない。
 * これにより「deny → 待機ack → 注入 → 言い換え待機ack → 注入 …」の空転が
 * echo 検知（文面一致・閾値6回）を待たずに1往復で止まる。
 * ---------------------------------------------------------------- */

/** 最後の人間入力メッセージの id（無ければ null）。
 * id はスライドウィンドウをまたいで安定するため、dedupe の人間アンカーに使う。
 * id 欠損時は空文字に倒す（null=不在と区別。衝突しても安定するため
 * dedupe が壊れない）。 */
export function lastHumanId(msgs: SessionMessageLike[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (
      m.info.role === "user" &&
      (m.parts ?? []).some((p) => isHumanTextPart(p))
    ) {
      const id: unknown = (m.info as { id?: unknown }).id;
      return typeof id === "string" ? id : "";
    }
  }
  return null;
}

/** 進展フィンガープリントを計算する（純粋関数・テスト容易性のため分離）。
 * 人間アンカーは配列インデックスではなくメッセージ id で持つ。
 * 末尾N取得のスライドウィンドウ下でも、deny/ack の追加では人間 id・tool 件数
 * ともに不変のため dedupe「1往復で止まる」が成立する。 */
export function continuationFingerprint(
  msgs: SessionMessageLike[],
  phase: Phase,
  evalCmd: string | null,
  evalFingerprint: string | null,
): string {
  const h = lastHumanId(msgs);
  let toolCalls = 0;
  let afterHuman = h === null;
  for (const m of msgs) {
    if (!afterHuman) {
      const id: unknown = (m.info as { id?: unknown }).id;
      if ((typeof id === "string" ? id : "") === h) {
        afterHuman = true;
      }
      continue;
    }
    for (const p of m?.parts ?? []) {
      if (p.type === "tool" && p.callID) toolCalls++;
    }
  }
  return fnv1a(
    canonicalJSON({
      h,
      t: toolCalls,
      p: phase,
      e: evalCmd ?? "",
      o: evalFingerprint ?? "",
    }),
  );
}

/** 継続リマインダーを注入したことを記録する（次回 idle の skip 判定材料） */
export function noteContinuation(root: string, marker: string): LoopState {
  const state = readState(root);
  const next = { ...state, last_continuation_marker: marker };
  writeState(root, next);
  return next;
}

/** 直近の eval 実行結果フィンガープリントを記録する */
export function noteEvalFingerprint(root: string, fp: string): LoopState {
  const state = readState(root);
  const next = { ...state, last_eval_fingerprint: fp };
  writeState(root, next);
  return next;
}

/** loop 停止時に goal を pause する（自動継続を物理的に止める）。累積停止回数
 * （loop_stop_count）を加算し、loop_stopped イベントを記録する。
 * pause は human の resume でしか解除されない。 */
export function stopLoopByPause(root: string): ActiveLoop | null {
  const state = readState(root);
  const count = state.loop_stop_count + 1;
  writeState(root, { ...state, loop_stop_count: count });
  const r = pauseGoal(root);
  if (r?.goal.id) {
    recordEvent(root, { type: "loop_stopped", goal: r.goal.id, count });
  }
  return r;
}

/** resume がブロックされているか（loop_stop_max に累積停止回数が達した） */
export function isResumeBlocked(root: string): boolean {
  const cfg = readConfig(root);
  if (cfg.loop_stop_max <= 0) return false;
  const state = readState(root);
  return state.loop_stop_count >= cfg.loop_stop_max;
}

/* ================================================================== *
 * stuck escalation: implementing での連続失敗を機械カウントし、
 * stuck_threshold に達したら graphhopper-oracle への相談を促す。
 * diffサイズ（router gate）とは別軸のタイミング判断——
 * 「詰まった回数」で上位モデルを呼ぶ graph engineering のもう1つの分岐点。
 * ================================================================== */

export interface AttemptResult {
  fail_streak: number;
  escalate: boolean;
  /** 連続失敗が max_eval_fails に達し、goal を pause すべきか */
  giveUp: boolean;
}

export function setEvalCmd(root: string, cmd: string): LoopState {
  const state = readState(root);
  const next: LoopState = { ...state, eval_cmd: cmd || null };
  writeState(root, next);
  if (state.goal_id)
    recordEvent(root, { type: "eval_set", goal: state.goal_id, cmd });
  return next;
}

export interface EvalResult {
  ok: boolean;
  output: string;
}

/** eval_cmd をシェルで実際に実行し、exit codeで機械的に合否判定する（自己申告に依存しない） */
export async function runEval(
  shell: Shell,
  root: string,
  cmd: string,
): Promise<EvalResult> {
  try {
    const r = await shell`sh -c ${cmd}`.cwd(root).nothrow().quiet();
    const output = [r.stdout.toString(), r.stderr.toString()]
      .filter(Boolean)
      .join("\n");
    return { ok: r.exitCode === 0, output };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

export function recordAttempt(
  root: string,
  ok: boolean,
  note: string,
): AttemptResult {
  const state = readState(root);
  const fail_streak = ok ? 0 : state.fail_streak + 1;
  // ok は進展の証拠: edit 堂々巡り・diff 停滞もリセットする
  // （idle の eval 経路と attempt(ok) 自己申告経路の両方に効く）
  writeState(root, {
    ...state,
    fail_streak,
    notes: note || state.notes,
    ...(ok
      ? { edit_file: null, edit_streak: 0, diff_stall: 0 }
      : {}),
  });
  const cfg = readConfig(root);
  const escalate = !ok && fail_streak >= cfg.stuck_threshold;
  const giveUp =
    !ok && cfg.max_eval_fails > 0 && fail_streak >= cfg.max_eval_fails;
  if (state.goal_id) {
    recordEvent(root, {
      type: "attempt",
      goal: state.goal_id,
      ok,
      fail_streak,
      note,
    });
  }
  return { fail_streak, escalate, giveUp };
}

/* ================================================================== *
 * stuck 信号の追加: fail_streak（連続失敗）に加え、同一ファイル再編集と
 * diff 停滞を機械カウントし、いずれかが閾値で oracle への相談を促す。
 * 「相談」と「諦め (giveUp)」は別軸——こちらは pause しない。
 * ================================================================== */

/** 同一ファイル連続編集の純粋遷移。同一 → +1、別 → リセット */
export function nextEditStreak(
  prev: { file: string | null; streak: number },
  file: string,
): { file: string; streak: number } {
  if (prev.file === file) return { file, streak: prev.streak + 1 };
  return { file, streak: 1 };
}

/** edit/write 成功時に同一ファイル streak を更新する */
export function noteEdit(root: string, filePath: string): LoopState {
  const state = readState(root);
  const next = nextEditStreak(
    { file: state.edit_file, streak: state.edit_streak },
    filePath,
  );
  const updated: LoopState = {
    ...state,
    edit_file: next.file,
    edit_streak: next.streak,
  };
  writeState(root, updated);
  return updated;
}

/** ワーキングコピー差分（親比）の行数を測る。stateless 測定のため
 * baseline 不要。jj → git fallback。両失敗時は null（何もしない）。 */
export async function measureWorkingCopyLines(
  shell: Shell,
  root: string,
): Promise<number | null> {
  try {
    const r = await shell`jj diff --stat`.cwd(root).nothrow().quiet();
    if (r.exitCode === 0) {
      const lines = r.stdout.toString().trim().split("\n");
      const parsed = parseDiffShortstat(lines[lines.length - 1] ?? "");
      if (parsed !== null) return parsed;
      // stat 出力なし（差分ゼロ）の判定: 空出力なら 0
      if (r.stdout.toString().trim() === "") return 0;
    }
  } catch {
    // ignore
  }
  try {
    const r = await shell`git diff --shortstat`.cwd(root).nothrow().quiet();
    if (r.exitCode === 0) {
      const out = r.stdout.toString().trim();
      if (out === "") return 0;
      return parseDiffShortstat(out) ?? 0;
    }
  } catch {
    // ignore
  }
  return null;
}

/** diff 停滞の純粋遷移。同一行数 → +1、変化・測定不能 → リセット */
export function nextDiffStall(
  prev: { lines: number | null; stall: number },
  lines: number | null,
): { lines: number | null; stall: number } {
  if (lines === null) return { lines: prev.lines, stall: 0 };
  if (prev.lines === lines) return { lines, stall: prev.stall + 1 };
  return { lines, stall: 0 };
}

/** diff 停滞を更新する（測定不能時は現状維持） */
export function noteDiffLines(
  root: string,
  lines: number | null,
): LoopState {
  const state = readState(root);
  const next = nextDiffStall(
    { lines: state.last_diff_lines, stall: state.diff_stall },
    lines,
  );
  const updated: LoopState = {
    ...state,
    last_diff_lines: next.lines,
    diff_stall: next.stall,
  };
  writeState(root, updated);
  return updated;
}

export interface StuckStatus {
  escalate: boolean;
  reasons: string[];
}

/** 進捗停滞シグナルの集約判定（読み取り専用。書き込みは note 系に分離）。
 * 同一ファイル再編集・diff 停滞の OR。fail_streak は対象外:
 * 全 caller が r.escalate==false 時のみ参照し、その条件は fail_streak<閾値と
 * 同値のため fail 枝は到達不能（dead につき削除。fail は recordAttempt 側が担う）。
 * 実 history でも stuck_hint 発火は edit/diff 系のみ想定。 */
export function checkStuck(root: string): StuckStatus {
  const cfg = readConfig(root);
  const state = readState(root);
  const reasons: string[] = [];
  if (
    cfg.stuck_edit_repeat > 1 &&
    state.edit_streak >= cfg.stuck_edit_repeat
  ) {
    reasons.push(`edit_repeat(${state.edit_file}×${state.edit_streak})`);
  }
  if (
    cfg.stuck_diff_stall > 1 &&
    state.diff_stall >= cfg.stuck_diff_stall
  ) {
    reasons.push(`diff_stall×${state.diff_stall}`);
  }
  return { escalate: reasons.length > 0, reasons };
}

/** stuck 通知した理由集合を記録する。同一理由なら stuck_hint を出さず
 * false を返す（通知スキップ）。理由変化で true＋イベント記録。 */
export function noteStuckNotified(root: string, reasons: string[]): boolean {
  const state = readState(root);
  const prev = state.last_stuck_reasons;
  const same =
    prev.length === reasons.length && prev.every((r, i) => r === reasons[i]);
  if (same) return false;
  writeState(root, { ...state, last_stuck_reasons: [...reasons] });
  if (state.goal_id) {
    recordEvent(root, {
      type: "stuck_hint",
      goal: state.goal_id,
      reasons: [...reasons],
    });
  }
  return true;
}

/* ================================================================== *
 * design gate（C-2不変条件）: designing フェーズで edit/write を許可パス以外に通さない
 * tool.execute.before hook から呼ばれる純関数（副作用なし）
 * ================================================================== */

import { isAbsolute, normalize, relative, sep } from "node:path";

/** gate判定用に filePath を root 相対・正規化する（`..` 解消・区切り統一）。
 * root 外の絶対パスは `..` 始まりになり、許可prefixに一致しない（fail-closed）。
 * deep検知のパス照合でも使うためexportする（純関数）。 */
export function normalizeForGate(root: string, filePath: string): string {
  const rel = isAbsolute(filePath) ? relative(root, filePath) : filePath;
  return normalize(rel).split(sep).join("/");
}

function matchesAllowed(normalized: string, prefix: string): boolean {
  const p = normalize(prefix).split(sep).join("/").replace(/\/+$/, "");
  return normalized === p || normalized.startsWith(`${p}/`);
}

export function isDesignGateBlocked(
  root: string,
  cfg: GraphhopperConfig,
  phase: Phase,
  filePath: string,
): boolean {
  if (phase !== "designing") return false;
  const n = normalizeForGate(root, filePath);
  return !cfg.design_gate_allow.some((prefix) => matchesAllowed(n, prefix));
}

/** design doc不変化ゲート: designing終了後は該当goalのdesign docへの書き込みを常にブロックする
 * （graphhopper本体 hooks/design-gate.sh の事後編集ブロックと同じ思想）。verifierのdrift検出
 * アンカーとして読むため、実装に合わせて書き直せると「driftをdesign doc側の書き換えで消せる」
 * Goodhart's Lawの穴になる。決定の経緯・進捗は planLogPath（追記専用・ハードゲート無し）へ。
 * design_gate_allow とは独立（designing中はこの関数は常にfalseを返す）。 */
export function isDesignDocLocked(
  root: string,
  phase: Phase,
  goalId: string,
  filePath: string,
): boolean {
  if (phase === "designing") return false;
  // 正規化後の完全一致。`.log.md`（`${goalId}.log.md`）は対象外のまま。
  return (
    normalizeForGate(root, filePath) === `.graphhopper/plans/${goalId}.md`
  );
}

/* ================================================================== *
 * discover（loop-until-dry）: phase graph の外にあるオンデマンド探索。
 * round cap / dedupe を code側で強制する（opencodeにWorkflow相当が無いため、
 * 「尽きるまで周回・でも確実に止まる」の保証をTS toolに持たせる）。
 * dedupeは「既見全体」（reject/未採用も含む）に対して行う——確定済みだけに
 * 対すると、一度リジェクトされたfindingが毎ラウンド再発見されて無限空転する。
 * ================================================================== */

const MAX_DISCOVER_ROUNDS = 8;
const DRY_ROUNDS_TO_STOP = 2;

export interface DiscoverState {
  target: string;
  scope: string;
  round: number;
  dry_streak: number;
  seen: string[];
  confirmed: {
    title: string;
    severity: string;
    confidence: number;
    quote: string;
  }[];
  stopped_reason: "dry" | "max_rounds" | null;
  started_at: string;
  /** 紐付く goal（開始時点の active。無ければ null）。lineage が載せる */
  goal_id: string | null;
}

function discoverPath(root: string): string {
  return join(dir(root), "discover.json");
}

export function startDiscover(
  root: string,
  target: string,
  scope: string,
  goalId: string | null = null,
): DiscoverState {
  const s: DiscoverState = {
    target,
    scope,
    round: 0,
    dry_streak: 0,
    seen: [],
    confirmed: [],
    stopped_reason: null,
    started_at: new Date().toISOString(),
    goal_id: goalId,
  };
  atomicWrite(discoverPath(root), s);
  return s;
}

export function readDiscover(root: string): DiscoverState | null {
  if (!existsSync(discoverPath(root))) return null;
  return readJson<DiscoverState | null>(discoverPath(root), null);
}

export interface DiscoverFinding {
  title: string;
  severity: string;
  confidence: number;
  quote: string;
}

/**
 * 1ラウンド分のfindingsを渡してdedupe・round/dry_streak更新を行う。
 * round capとdry判定はここで機械的に強制する（呼び出し側の自己申告に依存しない）。
 */
export function tickDiscover(
  root: string,
  findings: DiscoverFinding[],
): DiscoverState {
  const s = readDiscover(root);
  if (!s)
    throw new Error("no active discover session. call startDiscover first.");
  if (s.stopped_reason) return s; // 既に停止済みなら何もしない（冪等）

  s.round += 1;
  const seenSet = new Set(s.seen);
  const newOnes = findings.filter((f) => !seenSet.has(f.title));
  for (const f of findings) seenSet.add(f.title); // reject/未採用も含め全件seenに入れる
  s.seen = Array.from(seenSet);

  if (newOnes.length === 0) {
    s.dry_streak += 1;
  } else {
    s.dry_streak = 0;
    const adopted = newOnes.filter(
      (f) =>
        f.confidence >= 80 &&
        (f.severity === "critical" || f.severity === "high"),
    );
    s.confirmed.push(...adopted);
  }

  if (s.dry_streak >= DRY_ROUNDS_TO_STOP) s.stopped_reason = "dry";
  else if (s.round >= MAX_DISCOVER_ROUNDS) s.stopped_reason = "max_rounds";

  atomicWrite(discoverPath(root), s);
  return s;
}

export function clearDiscover(root: string): void {
  if (existsSync(discoverPath(root))) atomicWrite(discoverPath(root), null);
}

/* ================================================================== *
 * lineage（作業グラフの第一歩）: goals.json + history.jsonl から
 * goal ごとの系譜を導出する。MCP の lineage.json resource が読む。
 * graft（コードの構造）に対する「作業の構造」側の edge 素材。
 * ================================================================== */

/** history.jsonl の1行（recordEvent が付与する ts 付き） */
export type HistoryRecord = HistoryEvent & { ts?: string };

export function readHistory(root: string): HistoryRecord[] {
  const p = historyPath(root);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as HistoryRecord);
  } catch {
    return [];
  }
}

export interface GoalLineage {
  id: string;
  title: string;
  status: GoalStatus;
  /** 訪れた phase（順序保持・重複なし。先頭は常に designing） */
  phases: Phase[];
  /** polish → implementing の巻き戻し回数（verifier drift の機械証跡） */
  rewinds: number;
  verifier: { level: VerdictLevel; target: DriftTarget | null; lens: VerifierLens[] }[];
  critic: VerdictLevel | null;
  evalRuns: { pass: number; fail: number };
  maxFailStreak: number;
  gateBlocks: number;
  editedFiles: string[];
  routerChecks: { diff_lines: number; route: RouterRoute }[];
  /** complete時の機械採点（未completeは null） */
  score: GoalScore | null;
}

export function buildLineage(root: string): {
  goals: GoalLineage[];
  discover: DiscoverState | null;
} {
  const stored = readGoals(root);
  const byId = new Map<string, GoalLineage>();
  for (const g of stored.goals) {
    byId.set(g.id, {
      id: g.id,
      title: g.title,
      status: g.status,
      phases: ["designing"],
      rewinds: 0,
      verifier: [],
      critic: null,
      evalRuns: { pass: 0, fail: 0 },
      maxFailStreak: 0,
      gateBlocks: 0,
      editedFiles: [],
      routerChecks: [],
      score: g.score ?? null,
    });
  }
  const get = (goalId: string): GoalLineage | null => {
    let l = byId.get(goalId);
    if (!l) {
      // goals.json に無い（clear 済み等）が history に残る分は title 不明で計上
      l = {
        id: goalId,
        title: "(unknown)",
        status: "done",
        phases: ["designing"],
        rewinds: 0,
        verifier: [],
        critic: null,
        evalRuns: { pass: 0, fail: 0 },
        maxFailStreak: 0,
        gateBlocks: 0,
        editedFiles: [],
        routerChecks: [],
        score: null,
      };
      byId.set(goalId, l);
    }
    return l;
  };
  for (const h of readHistory(root)) {
    const goalId = (h as { goal?: unknown }).goal;
    if (typeof goalId !== "string") continue;
    const l = get(goalId);
    if (!l) continue;
    switch (h.type) {
      case "phase":
        if (!l.phases.includes(h.to)) l.phases.push(h.to);
        if (h.from === "polish" && h.to === "implementing") l.rewinds += 1;
        break;
      case "verifier_verdict":
        l.verifier.push({ level: h.level, target: h.target, lens: h.lens });
        break;
      case "critic_review_set":
        l.critic = h.level;
        break;
      case "eval_run":
        if (h.ok) l.evalRuns.pass += 1;
        else l.evalRuns.fail += 1;
        break;
      case "attempt":
        if (h.fail_streak > l.maxFailStreak) l.maxFailStreak = h.fail_streak;
        break;
      case "design_gate_block":
      case "design_doc_locked_block":
        l.gateBlocks += 1;
        break;
      case "hash_edit_applied":
        if (!l.editedFiles.includes(h.path)) l.editedFiles.push(h.path);
        break;
      case "router_check":
        l.routerChecks.push({ diff_lines: h.diff_lines, route: h.route });
        break;
      default:
        break;
    }
  }
  return { goals: [...byId.values()], discover: readDiscover(root) };
}

/* ================================================================== *
 * 評価機能A: モデル×役割の成績表。verdict/criticイベントの model 欄を
 * 集計する。帰属は記録値のみ（推測で紐付けない）。goal転帰は lineage 由来。
 * ================================================================== */

export interface ModelRoleStats {
  model: string;
  role: "verifier" | "critic";
  verdicts: number;
  clean: number;
  drift: number;
  /** 混成fan-outへの参加数（単一model eventは0。hints注記用） */
  mixed: number;
}

export interface GoalOutcome {
  id: string;
  title: string;
  status: GoalStatus;
  rewinds: number;
  evalPass: number;
  evalFail: number;
  score: number | null;
}

export interface Scoreboard {
  models: ModelRoleStats[];
  goals: GoalOutcome[];
  /** 人間向けの検討事項（提案のみ・自動適用なし。根拠つきで書く） */
  hints: string[];
}

/* hintsのガード値。サンプル不足での断定を防ぐ */
const HINT_MIN_MODEL_SAMPLES = 5;
const HINT_LOW_SCORE = 70;
const HINT_MANY_REWINDS = 2;

export function buildScoreboard(root: string): Scoreboard {
  const byModel = new Map<string, ModelRoleStats>();
  const bump = (
    model: string | null | undefined,
    role: "verifier" | "critic",
    level: VerdictLevel,
    mixed: boolean,
  ) => {
    const key = `${role}\0${model ?? "(unknown)"}`;
    let s = byModel.get(key);
    if (!s) {
      s = {
        model: model ?? "(unknown)",
        role,
        verdicts: 0,
        clean: 0,
        drift: 0,
        mixed: 0,
      };
      byModel.set(key, s);
    }
    s.verdicts += 1;
    if (level === "clean") s.clean += 1;
    else s.drift += 1;
    if (mixed) s.mixed += 1;
  };
  for (const h of readHistory(root)) {
    if (h.type === "verifier_verdict") {
      // 混成runはdistinct modelごとに行bump（単一modelは従来通り1 bump）。
      // levelは集約値（行内clean/drift整合は保たれる。hintsはper-row）。
      const models = h.models ?? [h.model];
      const distinct = [...new Set(models.map((m) => m ?? "(unknown)"))];
      const mixed = distinct.length > 1;
      for (const m of distinct) {
        bump(m === "(unknown)" ? null : m, "verifier", h.level, mixed);
      }
    } else if (h.type === "critic_review_set") bump(h.model, "critic", h.level, false);
  }
  const lin = buildLineage(root);
  const goals: GoalOutcome[] = lin.goals.map((g) => ({
    id: g.id,
    title: g.title,
    status: g.status,
    rewinds: g.rewinds,
    evalPass: g.evalRuns.pass,
    evalFail: g.evalRuns.fail,
    score: g.score?.value ?? null,
  }));
  const models = [...byModel.values()].sort((a, b) => b.verdicts - a.verdicts);
  return { models, goals, hints: buildHints(models, goals) };
}

/* scoreboard連動のmapping提案（B）。自動適用はしない。
 * drift検出率の高低は「厳格さ」と「実装荒れ」の両義性があるため断定せず、
 * 切り分け材料の提示に留める。サンプル不足は判断保留と明記する */
function buildHints(models: ModelRoleStats[], goals: GoalOutcome[]): string[] {
  const hints: string[] = [];
  for (const m of models) {
    if (m.mixed > 0) {
      hints.push(
        `${m.role} ${m.model}: 混成run ${m.mixed}件含む（帰属は集約level。lens別内訳はhistory参照）`,
      );
    }
    if (m.verdicts < HINT_MIN_MODEL_SAMPLES) {
      hints.push(
        `${m.role} ${m.model}: データ不足（${m.verdicts}件 < ${HINT_MIN_MODEL_SAMPLES}件）。判断保留`,
      );
      continue;
    }
    if (m.role === "verifier") {
      const driftRate = m.drift / m.verdicts;
      if (driftRate >= 0.6) {
        hints.push(
          `${m.model}: drift検出率 ${Math.round(driftRate * 100)}%（${m.verdicts}件）。厳格さと実装荒れの切り分けを推奨`,
        );
      } else if (m.clean === m.verdicts) {
        hints.push(
          `${m.model}: 全clean継続（${m.verdicts}件）。甘い可能性あり。要スポット確認`,
        );
      }
    }
  }
  for (const g of goals) {
    if (g.status === "done" && g.score !== null && g.score < HINT_LOW_SCORE) {
      hints.push(`${g.id} "${g.title}": score ${g.score}（<${HINT_LOW_SCORE}）。要振り返り`);
    }
    if (g.rewinds >= HINT_MANY_REWINDS) {
      hints.push(`${g.id}: 巻き戻し${g.rewinds}回。設計乖離が大きい（design/critic側の要因確認）`);
    }
  }
  return hints;
}
