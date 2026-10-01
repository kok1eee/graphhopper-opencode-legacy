/**
 * decision — d1 decision-model による入口トリアージ（jev置換）。
 *
 * Liquid decisions API専用。d1はchat LLMではなくテキストを生成しないため
 * opencode modelとしては配線できない。plugin/MCP tool `graphhopper_decide`
 * から直接HTTPSで叩く。本repo初の外部API呼び出し。
 * POST https://api.liquid.ai/decisions/v1/systemone（model d1:free、Choice型）。
 *
 * 失敗・低confidenceは一律 full（現行fail-safe極性＝重い側）。
 * decideはstateを書かない（route＋confidenceを返すのみ。route_setは呼び出し側）。
 */
import * as state from "./state";

export const DECISION_API_URL =
  "https://api.liquid.ai/decisions/v1/systemone";
export const DECISION_MODEL = "d1:free";
/** confidenceがこれ未満ならfullに倒す（初期値。scoreboardで調整） */
export const DECISION_CONFIDENCE_FLOOR = 0.6;
export const DECISION_TIMEOUT_MS = 15_000;

/* 5択criteria。現行JEV判定基準の移植（ラベルのみ送付は不可）。
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

type FetchFn = typeof fetch;

/* d1を叩いてrouteを返す。key未設定・HTTP失敗・例外は一律full（リトライなし） */
export async function decideRoute(
  request: string,
  fetchFn: FetchFn = fetch,
): Promise<DecideResult> {
  const key = process.env.LIQUID_API_KEY?.trim();
  if (!key) {
    return {
      route: "full",
      confidence: null,
      reason: "LIQUID_API_KEY未設定→full",
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DECISION_TIMEOUT_MS);
  try {
    const res = await fetchFn(DECISION_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DECISION_MODEL,
        state: request,
        questions: {
          route: {
            type: "choice",
            instructions:
              "この作業内容に適したgraphhopperの入口routeを1つ選べ。迷ったらfull",
            criteria: DECISION_ROUTE_CRITERIA,
          },
        },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return {
        route: "full",
        confidence: null,
        reason: `d1 HTTP ${res.status}→full`,
      };
    }
    const body = (await res.json()) as {
      answers?: { route?: { choice?: unknown; confidence?: unknown } };
    };
    return mapDecisionAnswer(
      body.answers?.route?.choice,
      body.answers?.route?.confidence,
    );
  } catch (e) {
    return {
      route: "full",
      confidence: null,
      reason: `d1呼出失敗(${e instanceof Error ? e.message : String(e)})→full`,
    };
  } finally {
    clearTimeout(timer);
  }
}
