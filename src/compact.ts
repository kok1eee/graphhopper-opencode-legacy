/**
 * compact — d1 keep-list gate for `experimental.session.compacting`.
 *
 * opencodeのcompactionはLLM要約（lossy）のため、goal意図・ファイルパス・
 * exact error等が要約落ちする。それを防ぐ制約（keep-list）をd1で作り
 * `output.context` にpushする。transcriptの書換えはしない
 * （APIが無い。DB直書きは破壊リスクのため拒否）。
 *
 * fail-open: DB不在・lock・key未設定・d1失敗・timeout・候補0件のいずれも
 * output無変更（既定compaction継続）。hook内でthrowしない。
 * skip時は decisions.jsonl に kind `compact`＋fallback:true＋理由を残す
 * （恒常no-op検出。較正データと区別する）。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { callDecision, extractNoulProbs, logDecision } from "./decision";

/** d1呼び出し総量budget（compaction待機文脈では初回遅延が逆効果のため単発・短timeout・リトライなし） */
export const COMPACT_TIMEOUT_MS = 8_000;
/** 候補上限（state長のバランス。超過分は切り捨て。初期値） */
export const COMPACT_CANDIDATE_MAX = 40;
/** 最新Nメッセージ内のtool結果は既定保全と見なし候補から除外する */
export const COMPACT_PRESERVE_RECENT_MESSAGES = 10;
/** state用に切り詰める1件あたりの文字数 */
export const COMPACT_ITEM_TRUNCATE = 800;
/** keep-list整形用：1件あたりのresult引用文字数 */
export const COMPACT_QUOTE_CHARS = 300;
/** push上限（件数・合計文字数。compaction prompt爆発の防止） */
export const COMPACT_KEEP_MAX = 20;
export const COMPACT_PUSH_MAX_CHARS = 8_000;
/** keep閾値（初期値。selectorと同値の借用。kind compactで較正後に調整） */
export const COMPACT_KEEP_THRESHOLD = 0.5;
/** 秘匿の疑いがある結果は候補から除外する */
export const COMPACT_SECRET_PATTERNS = [/sk-[A-Za-z0-9]{8,}/, /Bearer [A-Za-z0-9._~+/-]+/, /AKIA[0-9A-Z]{16}/];

export type CompactCandidate = {
  key: string;
  tool: string;
  inputSummary: string;
  outputText: string;
};

export type ToolRow = {
  data: string;
  message_id: string;
  time_created: number;
};

/* DBパス解決順。存在する最初のものを返す（無ければnull→skip） */
export function resolveCompactDb(): string | null {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const cands = [
    xdg ? join(xdg, "opencode", "opencode.db") : null,
    join(homedir(), ".local", "share", "opencode", "opencode.db"),
  ].filter((p): p is string => !!p);
  return cands.find((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  }) ?? null;
}

/* DB open定型の単一源泉（readonly＋busy_timeout。lock待機値のズレ防止） */
export function withCompactDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return fn(db);
  } finally {
    db.close();
  }
}

/* セッションのtool partを古い順に読む。lock等はthrow（gate側でskip化）。
 * 壊れJSONが1行あるとjson_extractがクエリ全体を殺すため、その場合は
 * 全件取得＋JS側フィルタにフォールバックする（1行のために全体を捨てない） */
export function readSessionToolRows(dbPath: string, sessionID: string): ToolRow[] {
  return withCompactDb(dbPath, (db) => {
    try {
      return db
        .query(
          `SELECT data, message_id, time_created FROM part
           WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
           ORDER BY time_created ASC`,
        )
        .all(sessionID) as ToolRow[];
    } catch {
      const all = db
        .query(
          `SELECT data, message_id, time_created FROM part
           WHERE session_id = ? ORDER BY time_created ASC`,
        )
        .all(sessionID) as ToolRow[];
      return all.filter((r) => {
        try {
          return (JSON.parse(r.data) as { type?: unknown }).type === "tool";
        } catch {
          return false;
        }
      });
    }
  });
}

/* セッションのmessage idを新しい順に読む（最新N除外用） */
export function readSessionMessageIds(dbPath: string, sessionID: string): string[] {
  return (
    withCompactDb(
      dbPath,
      (db) =>
        db.query(
          `SELECT id FROM message WHERE session_id = ? ORDER BY time_created DESC`,
        ).all(sessionID),
    ) as { id: string }[]
  ).map((r) => r.id);
}

function asText(v: unknown, max: number): string {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/* 候補抽出（純粋関数）。最新Nメッセージ除外・古い順cap・800字切詰め・
 * 秘匿除外。未完了・空結果・壊れJSONは落とす */
export function selectCandidates(
  rows: ToolRow[],
  messageIdsNewestFirst: string[],
): CompactCandidate[] {
  const preserved = new Set(
    messageIdsNewestFirst.slice(0, COMPACT_PRESERVE_RECENT_MESSAGES),
  );
  const out: CompactCandidate[] = [];
  for (const row of rows) {
    if (out.length >= COMPACT_CANDIDATE_MAX) break;
    let body: {
      tool?: unknown;
      state?: { status?: unknown; input?: unknown; output?: unknown };
    };
    try {
      body = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (!body || typeof body !== "object") continue;
    if (body.state?.status !== "completed") continue;
    if (preserved.has(row.message_id)) continue;
    const tool = typeof body.tool === "string" ? body.tool : "unknown";
    const inputSummary = asText(body.state?.input, 200);
    const outputText = asText(body.state?.output, COMPACT_ITEM_TRUNCATE);
    if (!outputText.trim()) continue;
    if (COMPACT_SECRET_PATTERNS.some((re) => re.test(inputSummary + outputText))) {
      continue;
    }
    out.push({
      key: `keep_${out.length}`,
      tool,
      inputSummary,
      outputText,
    });
  }
  return out;
}

/* Noul質問組立。d1はquestion IDを見ないため、対象の特定はinstructions内に書く */
export function buildKeepQuestions(cands: CompactCandidate[]): {
  stateText: string;
  questions: Record<string, { type: "noul"; instructions: string }>;
} {
  const stateText = [
    "以下はcompaction対象セッションのtool実行結果の一覧（古い順）である。",
    "この後の要約で失われると困るものを残すための判定材料とする。",
    "",
    ...cands.map(
      (c, i) =>
        `#${i} [${c.tool}] input: ${c.inputSummary}\nresult: ${c.outputText}`,
    ),
  ].join("\n");
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    questions[c.key] = {
      type: "noul",
      instructions:
        `一覧の #${i} [${c.tool}] の実行結果は、今後の作業にまだ必要か。` +
        `input概要: ${c.inputSummary}。必要（要約で失われると困る）ならyes`,
    };
  }
  return { stateText, questions };
}

/* keep-list整形。形式固定・20件/8k字cap。keptKeysは較正ログ用 */
export function formatKeepList(
  cands: CompactCandidate[],
  probs: Record<string, number>,
): { lines: string[]; keptKeys: string[] } {
  const lines: string[] = [];
  const keptKeys: string[] = [];
  let chars = 0;
  for (let i = 0; i < cands.length; i++) {
    if (lines.length >= COMPACT_KEEP_MAX) break;
    const c = cands[i];
    const p = probs[c.key] ?? 0;
    if (p < COMPACT_KEEP_THRESHOLD) continue;
    const line =
      `- [keep:${p.toFixed(2)}] ${c.tool} ${c.inputSummary} → ` +
      `"${c.outputText.slice(0, COMPACT_QUOTE_CHARS)}"`;
    if (chars + line.length > COMPACT_PUSH_MAX_CHARS) break;
    chars += line.length;
    lines.push(line);
    keptKeys.push(c.key);
  }
  return { lines, keptKeys };
}

export type CompactOutcome =
  | { kept: true; pushed: number }
  | { kept: false; reason: string };

/* goal意図push（g-mtl7l8j3の既存処理をそのまま移設）。戻り値はpush有無。
 * 型は最小構造（state.getActiveの戻り値は代入可能。手写し禁止） */
export type GoalIntentSource = {
  goal: { title: string; id: string; status: string };
  state: { phase: string; notes?: unknown; eval_cmd?: unknown };
};
export function pushGoalIntent(
  getActive: () => GoalIntentSource | null,
  push: (text: string) => void,
): boolean {
  const active = getActive();
  if (!active || active.goal.status !== "active") return false;
  push(
    [
      `[graphhopper] active goal: "${active.goal.title}" (${active.goal.id})`,
      `phase: ${active.state.phase}`,
      active.state.notes ? `notes: ${active.state.notes}` : null,
      active.state.eval_cmd ? `eval_cmd: ${active.state.eval_cmd}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return true;
}

export type CompactGateOpts = {
  dbPath: string | null;
  sessionID: string;
  root: string;
  push: (text: string) => void;
  fetchFn?: typeof fetch;
  /** テスト用。製品は既定（COMPACT_TIMEOUT_MS） */
  timeoutMs?: number;
};

/* hook本体。DB readからpushまで一貫して担い、throwしない。
 * hook側のread失敗もskip記録の対象にするため、読込はgate内に寄せる */
export async function runCompactGate(opts: CompactGateOpts): Promise<CompactOutcome> {
  const { dbPath, sessionID, root, push } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? COMPACT_TIMEOUT_MS;
  const skip = async (
    reason: string,
    probs?: Record<string, number>,
  ): Promise<CompactOutcome> => {
    await logDecision(root, {
      kind: "compact-skip",
      request: reason.slice(0, 200),
      result: [],
      confidence: null,
      probs: probs ?? {},
      latencyMs: 0,
      fallback: true,
      reason,
    });
    return { kept: false, reason };
  };
  if (!dbPath) return skip("DB未解決");
  if (!sessionID) return skip("sessionIDなし");
  try {
    return await runGateInner();
  } catch (e) {
    return skip(`内部例外(${e instanceof Error ? e.message : String(e)})`);
  }

  async function runGateInner(): Promise<CompactOutcome> {
    let rows: ToolRow[];
    let mids: string[];
    try {
      rows = readSessionToolRows(dbPath as string, sessionID);
      mids = readSessionMessageIds(dbPath as string, sessionID);
    } catch (e) {
      return skip(`DB読取失敗(${e instanceof Error ? e.message : String(e)})`);
    }
  let cands;
  try {
    cands = selectCandidates(rows, mids);
    if (cands.length === 0) return await skip("候補0件");
  } catch (e) {
    return skip(`候補抽出失敗(${e instanceof Error ? e.message : String(e)})`);
  }
  const { stateText, questions } = buildKeepQuestions(cands);
  const t0 = performance.now();
  const r = await callDecision(stateText, questions, fetchFn, timeoutMs);
  const latencyMs = Math.round(performance.now() - t0);
  if (!r.ok) return skip(r.reason);
  const probs = extractNoulProbs(r.answers, Object.keys(questions));
  const { lines, keptKeys } = formatKeepList(cands, probs);
  if (lines.length === 0) return skip("keep該当なし", probs);
  // F5: ヘッダもbudgetに含める（上限超過分は末尾から落とす）
  const header =
    "[graphhopper] compaction keep-list（以下は要約で失わず残せ。原文引用）:";
  const kept: string[] = [];
  let used = header.length;
  for (const line of lines) {
    if (used + 1 + line.length > COMPACT_PUSH_MAX_CHARS) break;
    used += 1 + line.length;
    kept.push(line);
  }
  if (kept.length === 0) return skip("push上限で全件脱落");
  push([header, ...kept].join("\n"));
  await logDecision(root, {
    kind: "compact",
    request: `compact: ${cands.length}件質問`.slice(0, 200),
    result: keptKeys.slice(0, kept.length),
    confidence: null,
    probs,
    latencyMs,
    fallback: false,
    reason: `${kept.length}/${cands.length}件keep`,
  });
    return { kept: true, pushed: kept.length };
  }
}
