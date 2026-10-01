import { describe, expect, test } from "bun:test";
import {
  DECISION_CONFIDENCE_FLOOR,
  decideRoute,
  mapDecisionAnswer,
} from "./decision";

describe("mapDecisionAnswer（d1 choice写像）", () => {
  test("5択はそのまま通す", () => {
    for (const r of ["full", "light", "direct", "advised", "oracle"]) {
      expect(mapDecisionAnswer(r, 0.99)).toMatchObject({ route: r });
    }
  });
  test("低confidenceはfullに倒す", () => {
    const r = mapDecisionAnswer("light", DECISION_CONFIDENCE_FLOOR - 0.01);
    expect(r.route).toBe("full");
    expect(r.reason).toContain("低confidence");
  });
  test("境界値（==floor）は通す", () => {
    expect(
      mapDecisionAnswer("light", DECISION_CONFIDENCE_FLOOR).route,
    ).toBe("light");
  });
  test("不正choice・5択外・非文字列はfull", () => {
    expect(mapDecisionAnswer("unknown", 0.99).route).toBe("full");
    expect(mapDecisionAnswer(null, 0.99).route).toBe("full");
    expect(mapDecisionAnswer(42, 0.99).route).toBe("full");
  });
  test("confidence欠測は通す（null許容）", () => {
    const r = mapDecisionAnswer("direct", undefined);
    expect(r).toMatchObject({ route: "direct", confidence: null });
  });
});

describe("decideRoute（fail-safe）", () => {
  const saved = process.env.LIQUID_API_KEY;
  const setKey = (v: string | undefined) => {
    if (v === undefined) delete process.env.LIQUID_API_KEY;
    else process.env.LIQUID_API_KEY = v;
  };
  const restore = () => {
    if (saved === undefined) delete process.env.LIQUID_API_KEY;
    else process.env.LIQUID_API_KEY = saved;
  };

  test("key未設定→full", async () => {
    setKey(undefined);
    try {
      const r = await decideRoute("何かやる");
      expect(r.route).toBe("full");
      expect(r.reason).toContain("LIQUID_API_KEY未設定");
    } finally {
      restore();
    }
  });

  test("HTTP失敗→full（fetchは1回のみ）", async () => {
    setKey("liquid_test");
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return { ok: false, status: 429 } as Response;
    }) as unknown as typeof fetch;
    try {
      const r = await decideRoute("何かやる", fakeFetch);
      expect(r.route).toBe("full");
      expect(r.reason).toContain("429");
      expect(calls).toBe(1);
    } finally {
      restore();
    }
  });

  test("正常応答→choice通り", async () => {
    setKey("liquid_test");
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({
        answers: { route: { choice: "light", confidence: 0.9 } },
      }),
    })) as unknown as typeof fetch;
    try {
      const r = await decideRoute("何かやる", fakeFetch);
      expect(r).toMatchObject({ route: "light", confidence: 0.9 });
    } finally {
      restore();
    }
  });
});
