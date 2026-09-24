/** graphhopper_invoke の unit test（実opencode runはT1の1回のみ・ここではseam差替え）。 */
import { describe, expect, test, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  DEPTH_ENV,
  MAX_DEPTH,
  PROMPT_MAX_CHARS,
  STDOUT_MAX_CHARS,
  buildArgs,
  invoke,
  resolveModel,
  runChild,
  type SpawnFn,
} from "./invoke";

interface FakeProc extends EventEmitter {
  pid: number;
  killCalled: string[];
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function fakeSpawn(behavior: (p: FakeProc) => void): SpawnFn {
  return ((_cmd: string, _args: string[], _opts: unknown) => {
    const p = new EventEmitter() as FakeProc;
    p.pid = 424242;
    p.killCalled = [];
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    setTimeout(() => behavior(p), 0);
    return p as unknown as ChildProcess;
  }) as SpawnFn;
}

const okSpawn: SpawnFn = fakeSpawn((p) => {
  p.stdout.emit("data", Buffer.from("hello", "utf8"));
  p.emit("exit", 0);
});

afterEach(() => {
  delete process.env[DEPTH_ENV];
});

describe("invoke 引数検証", () => {
  test("未知agent→エラー文字列", async () => {
    const out = await invoke({ agent: "nope", prompt: "hi", root: "/tmp" }, okSpawn);
    expect(out).toMatch("unknown agent");
  });
  test("不正model→エラー文字列", async () => {
    const out = await invoke(
      { agent: "graphhopper-critic", model: "no-slash here", prompt: "hi", root: "/tmp" },
      okSpawn,
    );
    expect(out).toMatch("invalid model");
  });
  test("prompt超過→エラー文字列", async () => {
    const out = await invoke(
      { agent: "graphhopper-critic", prompt: "x".repeat(PROMPT_MAX_CHARS + 1), root: "/tmp" },
      okSpawn,
    );
    expect(out).toMatch("prompt too long");
  });
  test("depth>=1→再帰拒否", async () => {
    process.env[DEPTH_ENV] = String(MAX_DEPTH);
    const out = await invoke({ agent: "graphhopper-critic", prompt: "hi", root: "/tmp" }, okSpawn);
    expect(out).toMatch("nested");
  });
});

describe("buildArgs", () => {
  test("基本形（-- 境界・shell非経由の配列）", () => {
    const a = buildArgs({ agent: "graphhopper-critic", model: "p/m", dir: "/r", title: "t", prompt: "hi" });
    expect(a).toEqual(["run", "--model", "p/m", "--agent", "graphhopper-critic", "--dir", "/r", "--title", "t", "--", "hi"]);
  });
  test("model省略時はflag自体付けない", () => {
    const a = buildArgs({ agent: "graphhopper-critic", dir: "/r", title: "t", prompt: "hi" });
    expect(a.includes("--model")).toBe(false);
  });
  test("先頭--modelのpromptもflag化されない", () => {
    const a = buildArgs({ agent: "graphhopper-critic", dir: "/r", title: "t", prompt: "--model evil" });
    const sep = a.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    expect(a.slice(sep + 1)).toEqual(["--model evil"]);
  });
});

describe("resolveModel", () => {
  test("引数優先", () => {
    expect(resolveModel("/tmp/gh-nope", "graphhopper-critic", "p/m")).toBe("p/m");
  });
  test("config既定を読む", () => {
    const root = mkdtempSync(join(tmpdir(), "gh-invoke-"));
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "config.json"),
      JSON.stringify({ agents: { "graphhopper-critic": "z/x" } }),
      "utf8",
    );
    expect(resolveModel(root, "graphhopper-critic")).toBe("z/x");
  });
});

describe("runChild", () => {
  test("成功出力", async () => {
    const r = await runChild("opencode", ["run"], { timeoutMs: 5000, cwd: "/tmp", childEnv: {} }, okSpawn);
    expect(r.output).toBe("hello");
    expect(r.timedOut).toBe(false);
  });
  test("30000文字打切り", async () => {
    const big: SpawnFn = fakeSpawn((p) => {
      p.stdout.emit("data", Buffer.from("y".repeat(STDOUT_MAX_CHARS + 10), "utf8"));
      p.emit("exit", 0);
    });
    const r = await runChild("opencode", ["run"], { timeoutMs: 5000, cwd: "/tmp", childEnv: {} }, big);
    expect(r.output).toMatch("truncated");
  });
  test("非0終了はstderr末尾付き", async () => {
    const bad: SpawnFn = fakeSpawn((p) => {
      p.stderr.emit("data", Buffer.from("boom happened", "utf8"));
      p.emit("exit", 1);
    });
    const r = await runChild("opencode", ["run"], { timeoutMs: 5000, cwd: "/tmp", childEnv: {} }, bad);
    expect(r.output).toMatch("code 1");
    expect(r.output).toMatch("boom happened");
  });
  test("fallback警告を検出", async () => {
    const fb: SpawnFn = fakeSpawn((p) => {
      p.stderr.emit("data", Buffer.from("Falling back to default agent", "utf8"));
      p.emit("exit", 0);
    });
    const r = await runChild("opencode", ["run"], { timeoutMs: 5000, cwd: "/tmp", childEnv: {} }, fb);
    expect(r.fallbackWarning).toBe(true);
    expect(r.output).toMatch("warning:");
  });
  test("timeoutでkill", async () => {
    let killed = "";
    const hang: SpawnFn = ((_cmd: string, _args: string[], _opts: unknown) => {
      const p = new EventEmitter() as FakeProc;
      p.pid = 999999;
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      (p as unknown as { kill: (s: string) => boolean }).kill = (s: string) => {
        killed = s;
        return true;
      };
      return p as unknown as ChildProcess;
    }) as SpawnFn;
    // process.kill(-pid)は存在しないpidで失敗→child.killにフォールバックする想定
    const r = await runChild(
      "opencode",
      ["run"],
      { timeoutMs: 100, cwd: "/tmp", childEnv: {} },
      hang,
    );
    expect(r.timedOut).toBe(true);
    expect(r.output).toMatch("timeout");
    expect(killed).toBe("SIGKILL");
  }, 15000);
});

describe("invoke 並列安全（中断・heartbeat・ずらし）", () => {
  function hangProc(onKill?: (s: string) => void): SpawnFn {
    return ((_cmd: string, _args: string[], _opts: unknown) => {
      const p = new EventEmitter() as FakeProc;
      p.pid = 999998;
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      (p as unknown as { kill: (s: string) => boolean }).kill = (s: string) => {
        onKill?.(s);
        return true;
      };
      return p as unknown as ChildProcess;
    }) as SpawnFn;
  }

  test("abortでkillしcancelledで返す", async () => {
    const kills: string[] = [];
    const ac = new AbortController();
    const p = runChild(
      "opencode",
      ["run"],
      { timeoutMs: 5000, cwd: "/tmp", childEnv: {}, signal: ac.signal, killGraceMs: 20 },
      hangProc((s) => kills.push(s)),
    );
    setTimeout(() => ac.abort(), 30);
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.output).toMatch("cancelled");
    expect(kills).toContain("SIGTERM");
  });

  test("heartbeat tickが呼ばれる", async () => {
    const ticks: number[] = [];
    const ac = new AbortController();
    const p = runChild(
      "opencode",
      ["run"],
      {
        timeoutMs: 5000,
        cwd: "/tmp",
        childEnv: {},
        signal: ac.signal,
        killGraceMs: 20,
        heartbeatMs: 20,
        onTick: (ms) => ticks.push(ms),
      },
      hangProc(),
    );
    setTimeout(() => ac.abort(), 70);
    await p;
    expect(ticks.length).toBeGreaterThanOrEqual(1);
  });

  test("delayMsで起動がずれる", async () => {
    const { invokeStructured } = await import("./invoke");
    const t0 = Date.now();
    const r = await invokeStructured(
      { agent: "graphhopper-critic", prompt: "hi", root: "/tmp", delayMs: 80 },
      okSpawn,
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
    expect(r.cancelled).toBe(false);
    expect(r.output).toMatch("hello");
  });

  test("spawn前abortはspawnせずcancelled", async () => {
    const { invokeStructured } = await import("./invoke");
    const ac = new AbortController();
    ac.abort();
    let spawned = false;
    const spy: SpawnFn = ((_c: string, _a: string[], _o: unknown) => {
      spawned = true;
      const p = new EventEmitter() as FakeProc;
      p.pid = 1;
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      return p as unknown as ChildProcess;
    }) as SpawnFn;
    const r = await invokeStructured(
      { agent: "graphhopper-critic", prompt: "hi", root: "/tmp" },
      spy,
      { signal: ac.signal },
    );
    expect(spawned).toBe(false);
    expect(r.cancelled).toBe(true);
  });
});
