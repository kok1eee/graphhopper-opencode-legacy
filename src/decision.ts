/**
 * decision — d1 decision-model 共通基盤（入口route・selector等の利用元が共有）。
 *
 * Liquid decisions API専用。d1はchat LLMではなくテキストを生成しないため
 * opencode modelとしては配線できない。plugin/MCP toolから直接HTTPSで叩く。
 * POST https://api.liquid.ai/decisions/v1/systemone（model d1:free）。
 *
 * 構成: callDecision（HTTP・認証・timeout・例外握りの唯一の窓口）の上に
 * 用途別の関数（decideRoute／selectLenses）を載せる。新しい利用場所を足す時は
 * callDecisionを再利用し、HTTP部分をコピーしないこと。
 *
 * 失敗は呼び出し側が極性を決める（routeはfull、selectorはfallback=true）。
 * 本モジュールはstateを書かない。
 */
import * as state from "./state";

export const DECISION_API_URL =
  "https://api.liquid.ai/decisions/v1/systemone";
export const DECISION_MODEL = "d1:free";
/** routeのconfidenceがこれ未満ならfullに倒す（初期値。scoreboardで調整） */
export const DECISION_CONFIDENCE_FLOOR = 0.6;
export const DECISION_TIMEOUT_MS = 15_000;
/** selectorはadvisory-onlyで取りこぼしの害が小さい。d1:freeはレイテンシがぶれる
 * （実測3〜15s超）ため、遅い時は短く切ってfallbackに倒す（待たせない） */
export const SELECTOR_TIMEOUT_MS = 5_000;
/** selectorのみ、一過性の失敗（timeout/429/5xx/ネットワーク）を最大2回リトライする。
 * d1:freeはコールドスタートで初回が15s級に遅れ、温まると0.3s台になるため、
 * 打ち切った初回がサーバーを起こし、2回目以降で拾える。最悪 5s×3=15s */
export const SELECTOR_RETRIES = 2;
/** selectorのNoul採用閾値（0.5＝公式docの「最大不確実」中点。初期値） */
export const SELECTOR_NOUL_THRESHOLD = 0.5;

type FetchFn = typeof fetch;

/* d1の1問分の定義（公式doc: type=noul|choice|score） */
export type DecisionQuestion =
  | { type: "noul"; instructions: string }
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    };

export type DecisionAnswers = Record<
  string,
  { noul?: unknown; choice?: unknown; confidence?: unknown }
>;

export type CallResult =
  | { ok: true; answers: DecisionAnswers }
  /** retryable=true: 再試行で直りうる一過性の失敗（timeout/429/5xx/ネットワーク） */
  | { ok: false; reason: string; retryable: boolean };

/* d1を叩く唯一の窓口。key未設定・HTTP失敗・例外・不正JSONは ok:false（リトライなし）。
 * 極性（fullに倒すかfallbackにするか）は呼び出し側が決める */
export async function callDecision(
  stateText: string,
  questions: Record<string, DecisionQuestion>,
  fetchFn: FetchFn = fetch,
  timeoutMs: number = DECISION_TIMEOUT_MS,
): Promise<CallResult> {
  const key = process.env.LIQUID_API_KEY?.trim();
  if (!key) return { ok: false, reason: "LIQUID_API_KEY未設定", retryable: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(DECISION_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DECISION_MODEL,
        state: stateText,
        questions,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: `d1 HTTP ${res.status}`,
        retryable: res.status === 429 || res.status >= 500,
      };
    }
    const body = (await res.json()) as { answers?: DecisionAnswers };
    if (!body.answers || typeof body.answers !== "object") {
      return { ok: false, reason: "d1応答にanswersなし", retryable: false };
    }
    return { ok: true, answers: body.answers };
  } catch (e) {
    return {
      ok: false,
      reason: `d1呼出失敗(${e instanceof Error ? e.message : String(e)})`,
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* callDecision＋一過性失敗のみ最大retries回リトライ。key未設定・4xx・不正応答は即返す。
 * 入口routeは使わない（goal開始時の一度きりで待たせたくない。失敗してもfullに倒れるだけ） */
export async function callDecisionWithRetry(
  stateText: string,
  questions: Record<string, DecisionQuestion>,
  fetchFn: FetchFn = fetch,
  timeoutMs: number = DECISION_TIMEOUT_MS,
  retries: number = 0,
): Promise<CallResult> {
  let last: CallResult = { ok: false, reason: "未実行", retryable: false };
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await callDecision(stateText, questions, fetchFn, timeoutMs);
    if (last.ok || !last.retryable) return last;
  }
  return last.ok
    ? last
    : { ...last, reason: `${last.reason}（${retries + 1}回試行）` };
}

/* ───────── 入口route ───────── */

/* 5択criteria。現行判定基準の移植（ラベルのみ送付は不可）。
 * fullは「以下に当てはまらない全て」のため該当文で定義する */
export const DECISION_ROUTE_CRITERIA: Record<state.EntryRoute, string> = {
  full: "フルループ。設計判断を要する・複数関心にまたがる・規模不明・曖昧・以下のいずれにも当てはまらない全ての作業",
  light:
    "軽量。全て満たす時のみ → (1)単一関心 (2)設計判断なし (3)既存パターンの踏襲 (4)テスト容易。1つでも欠けたらfull",
  advised:
    "軽量＋第二意見。light条件を満たす＋影響範囲の読みに迷いがある／第二意見が欲しい軽微変更",
  oracle:
    "多角。full相当＋最初から多角的視点が必要（アーキテクチャ判断・複雑デバッグ・不慣れなパターン）",
  direct: "直行。単一ファイルの小修正・質問への回答・一回きりのコマンド実行",
};

export type DecideResult = {
  route: state.EntryRoute;
  confidence: number | null;
  reason: string;
};

/* d1応答のchoice＋confidence→route写像（純粋関数。単体テスト対象）。
 * 不正choice・5択外・低confidenceはfull */
export function mapDecisionAnswer(
  choice: unknown,
  confidence: unknown,
): DecideResult {
  const route =
    typeof choice === "string" ? state.normalizeEntryRoute(choice) : null;
  if (!route) {
    return { route: "full", confidence: null, reason: "d1不正choice→full" };
  }
  const conf = typeof confidence === "number" ? confidence : null;
  if (conf !== null && conf < DECISION_CONFIDENCE_FLOOR) {
    return {
      route: "full",
      confidence: conf,
      reason: `d1低confidence(${conf})→full`,
    };
  }
  return { route, confidence: conf, reason: `d1判定(${route})` };
}

/* 入口routeをd1で判定する。失敗は一律full（現行fail-safe極性＝重い側） */
export async function decideRoute(
  request: string,
  fetchFn: FetchFn = fetch,
): Promise<DecideResult> {
  const r = await callDecision(
    request,
    {
      route: {
        type: "choice",
        instructions:
          "この作業内容に適したgraphhopperの入口routeを1つ選べ。迷ったらfull",
        criteria: DECISION_ROUTE_CRITERIA,
      },
    },
    fetchFn,
  );
  if (!r.ok) return { route: "full", confidence: null, reason: `${r.reason}→full` };
  return mapDecisionAnswer(
    r.answers.route?.choice,
    r.answers.route?.confidence,
  );
}

/* ───────── verifier編成selector ───────── */

/* 契約変更系キーワード（日英混在）。design抜粋にマッチしたらrequirementを強制追加する。
 * 誤検出（「互換性テストの追加」等）は許容: requirementは取りこぼし防止側で、
 * 追加しても検証が1 lens増えるだけ。偽陽性より偽陰性の方が害が大きい */
export const SELECTOR_FORCE_REQUIREMENT =
  /契約|migration|互換|breaking|schema|スキーマ/i;

/* selectorがNoulで判定するlensのキー（generalは含めない）。質問定義・組立・欠測判定の単一源泉 */
export const SELECTOR_LENS_KEYS = ["requirement", "behavior", "progress"] as const;
export type SelectorLensKey = (typeof SELECTOR_LENS_KEYS)[number];

/* 3観点のNoul質問。generalは質問にしない（「3観点を統合した単発」で他lensと排他。
 * どれも閾値に届かなければ「該当なし→general」とする） */
export const SELECTOR_QUESTIONS: Record<SelectorLensKey, DecisionQuestion> = {
  requirement: {
    type: "noul",
    instructions:
      "この変更は、設計意図・done定義との一致を重点的に検証する必要があるか。契約・互換性・仕様の変更が絡むなら必要",
  },
  behavior: {
    type: "noul",
    instructions:
      "この変更は、振る舞い・テスト・副作用を重点的に検証する必要があるか。実行時の挙動や状態遷移に影響するなら必要",
  },
  progress: {
    type: "noul",
    instructions:
      "この変更は、進捗・残件・タスク列との対応を重点的に検証する必要があるか。複数タスクにまたがり取りこぼしが起きうるなら必要",
  },
};

export type SelectResult = {
  lenses: state.VerifierLens[];
  reason: string;
  /** true＝判定不能（API失敗等）。呼び出し側は従来routerを継続せよ（generalへ倒さない） */
  fallback: boolean;
};

/* Noul確率→lens集合の組立（純粋関数。単体テスト対象）。
 * - 閾値以上のlensを採用（最大3件）
 * - 全て閾値未満＝「該当なし」→ general（fallbackではない）
 * - design抜粋が契約変更系キーワードにマッチ → requirementを強制追加
 * - 有効なNoulが1件も無い（欠測）＝判定不能 → fallback=true（general倒しはしない） */
export function assembleLenses(
  answers: DecisionAnswers,
  designExcerpt: string,
): SelectResult {
  const probs: Partial<Record<SelectorLensKey, number>> = {};
  for (const k of SELECTOR_LENS_KEYS) {
    const v = answers[k]?.noul;
    if (typeof v === "number") probs[k] = v;
  }
  if (Object.keys(probs).length === 0) {
    return {
      lenses: [],
      reason: "d1応答に有効なNoulなし→従来router",
      fallback: true,
    };
  }
  const hit = SELECTOR_LENS_KEYS.filter(
    (k) => (probs[k] ?? 0) >= SELECTOR_NOUL_THRESHOLD,
  );
  const forced =
    SELECTOR_FORCE_REQUIREMENT.test(designExcerpt) && !hit.includes("requirement");
  const picked: SelectorLensKey[] = forced ? ["requirement", ...hit] : hit;
  const lenses: state.VerifierLens[] = picked.length > 0 ? picked : ["general"];
  const fmt = (k: SelectorLensKey) => `${k}=${probs[k]?.toFixed(2) ?? "n/a"}`;
  const reason =
    `d1選択(${SELECTOR_LENS_KEYS.map(fmt).join(",")})` +
    (forced ? " requirement強制(契約変更系キーワード)" : "") +
    (picked.length === 0 ? " 該当なし→general" : "");
  return { lenses, reason, fallback: false };
}

/* selector toolの人用テキスト（plugin/MCP両面の単一源泉。文面ズレ防止） */
export const SELECTOR_TOOL_DESCRIPTION =
  "verifier編成selectorをd1 decision-modelで判定する（advisory-only。現行routerは維持）。design抜粋とdiff統計を渡すとlens（1-3件）を返す。判定不能時はfallback=true（従来routerを継続。general倒しはしない）";

export function formatSelectorResult(r: SelectResult): string {
  return r.fallback
    ? `selector: 判定不能（${r.reason}）。従来router（advisor/polish）を継続せよ（general倒しはしない）。`
    : `selector: lenses=${r.lenses.join(",")}（${r.reason}）。verifier編成の参考にする（advisory-only。採否はmainが決める）。`;
}

/* verifier編成をd1で選ぶ。API失敗・key未設定・全Noul欠測は fallback=true */
export async function selectLenses(
  designExcerpt: string,
  diffStat: string,
  fetchFn: FetchFn = fetch,
): Promise<SelectResult> {
  const r = await callDecisionWithRetry(
    ["design抜粋:", designExcerpt, "", "diff統計:", diffStat].join("\n"),
    SELECTOR_QUESTIONS,
    fetchFn,
    SELECTOR_TIMEOUT_MS,
    SELECTOR_RETRIES,
  );
  if (!r.ok) {
    return { lenses: [], reason: `${r.reason}→従来router`, fallback: true };
  }
  return assembleLenses(r.answers, designExcerpt);
}
