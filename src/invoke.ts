/**
 * graphhopper_invoke の実体（design g-mu5d6avj）。
 * `opencode run --model --agent --dir` をargv配列でspawnし、結果を文字列で返す。
 * throwしない（エラーは文字列返却＝MCP流儀）。
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { GRAPHHOPPER_AGENTS } from "./agents";
import { readConfig } from "./state";

export const PROMPT_MAX_CHARS = 12000;
export const STDOUT_MAX_CHARS = 30000;
export const DEFAULT_TIMEOUT_MS = 120000;
export const MAX_TIMEOUT_MS = 300000;
export const MIN_TIMEOUT_MS = 10000;
export const KILL_GRACE_MS = 5000;
/** fan-out thundering herd回避用の起動ずらし上限。並列既定は維持しopt-inで使う */
export const MAX_DELAY_MS = 60000;
/** 子プロセス生存中のheartbeat間隔（MCP logging経由で「固まり」知覚を防ぐ） */
export const HEARTBEAT_MS = 30000;
export const DEPTH_ENV = "GH_INVOKE_DEPTH";
export const MAX_DEPTH = 1;

const KNOWN_BINARY =
  `${process.env["HOME"] ?? ""}/.local/share/mise/installs/opencode/latest/opencode`;

export interface InvokeArgs {
  agent: string;
  model?: string;
  prompt: string;
  root: string;
  timeoutMs?: number;
  /** 起動前の待機ms（並列fan-outの429 herd回避用。0既定・上限あり） */
  delayMs?: number;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: SpawnOptions & { env?: NodeJS.ProcessEnv },
) => ChildProcess;

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { env?: NodeJS.ProcessEnv },
): ChildProcess {
  return spawn(cmd, args, opts);
}

/** opencode binary解決。MCP serverのPATHに載らない場合に備え既知パスへフォールバック。 */
export function resolveBinary(): string | null {
  try {
    const out = execSync("command -v opencode", { encoding: "utf8" }).trim().split("\n")[0];
    if (out) return out;
  } catch {
    // フォールバックへ
  }
  try {
    execSync(`test -x ${JSON.stringify(KNOWN_BINARY)}`);
    return KNOWN_BINARY;
  } catch {
    return null;
  }
}

function validModel(m: string): boolean {
  return m.includes("/") && !/\s/.test(m) && m.length < 200;
}

/** argv組立（純関数・shell非経由）。`--` でmessage境界を明示する。 */
export function buildArgs(a: { agent: string; model?: string; dir: string; title: string; prompt: string }): string[] {
  const args = ["run"];
  if (a.model) args.push("--model", a.model);
  args.push("--agent", a.agent, "--dir", a.dir, "--title", a.title, "--", a.prompt);
  return args;
}

/** モデル解決: 引数 → config既定 → 未指定（子の既定。継承とは呼ばない）。 */
export function resolveModel(root: string, agent: string, model?: string): string | undefined {
  if (model) return model;
  const cfg = readConfig(root);
  return cfg.agents[agent];
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n... (truncated)` : s;
}

export interface InvokeResult {
  output: string;
  timedOut: boolean;
  fallbackWarning: boolean;
  /** clientキャンセルでkillしたか（並列fan-outの取り消し漏れ防止） */
  cancelled: boolean;
}

export interface RunChildOpts {
  timeoutMs: number;
  cwd: string;
  childEnv: NodeJS.ProcessEnv;
  /** 中断伝播: abortでgroup killしcancelledで返す（MCP CallToolのextra.signal） */
  signal?: AbortSignal;
  /** heartbeat間隔ms（onTick呼び出し。0以下で無効） */
  heartbeatMs?: number;
  onTick?: (elapsedMs: number) => void;
  /** SIGTERM後のSIGKILLまでの猶予ms（既定KILL_GRACE_MS。テスト用に短縮可） */
  killGraceMs?: number;
}

/** 子プロセス実行（seam付き・group kill対応・中断/heartbeat付き）。 */
export function runChild(
  binary: string,
  args: string[],
  opts: RunChildOpts,
  spawnFn: SpawnFn = defaultSpawn,
): Promise<InvokeResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawnFn(binary, args, {
      cwd: opts.cwd,
      env: opts.childEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (timedOut: boolean, cancelled = false): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (beat) clearInterval(beat);
      opts.signal?.removeEventListener("abort", onAbort);
      const fallbackWarning = /Falling back to default agent/.test(stderr);
      let output = truncate(stdout, STDOUT_MAX_CHARS);
      if (cancelled) {
        output += `\nerror: invoke cancelled by client (killed)`;
      } else if (timedOut) {
        output += `\nerror: invoke timeout after ${opts.timeoutMs}ms (killed; orphaned child may continue billing)`;
      } else if (code !== 0) {
        const tail = stderr.split("\n").slice(-20).join("\n");
        output += `\nerror: opencode run exited with code ${code}\n${tail}`;
      }
      if (fallbackWarning) {
        output += `\nwarning: agent fell back to default (read-only not enforced by agent def)`;
      }
      resolvePromise({ output, timedOut, fallbackWarning, cancelled });
    };
    let code: number | null = 0;
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", () => finish(false));
    child.on("exit", (c) => {
      code = c;
      finish(false);
    });
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // kill失敗は無視（孤児化の可能性をtimeout文で明示済み）
        }
      }
    };
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const graceMs = opts.killGraceMs ?? KILL_GRACE_MS;
    const timer = setTimeout(() => {
      killGroup("SIGTERM");
      graceTimer = setTimeout(() => {
        killGroup("SIGKILL");
        finish(true);
      }, graceMs);
    }, opts.timeoutMs);
    // 中断伝播: clientキャンセルで即kill（取り消し後も裏で回り続ける事故を防ぐ）
    const onAbort = (): void => {
      killGroup("SIGTERM");
      setTimeout(() => {
        if (!done) killGroup("SIGKILL");
        finish(false, true);
      }, graceMs);
    };
    if (opts.signal?.aborted) {
      onAbort();
    } else {
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    }
    // heartbeat: 長時間実行の「固まり」知覚を防ぐ（MCP logging等へ中継）
    const hb = opts.heartbeatMs ?? HEARTBEAT_MS;
    const beat =
      hb > 0 && opts.onTick
        ? setInterval(() => {
            if (!done) opts.onTick?.(Date.now() - started);
          }, hb)
        : null;
  });
}

/** graphhopper_invoke 本体。成功・失敗すべて文字列で返す。 */
export async function invoke(
  args: InvokeArgs,
  spawnFn: SpawnFn = defaultSpawn,
): Promise<string> {
  return (await invokeStructured(args, spawnFn)).output;
}

export interface InvokeStructuredResult {
  output: string;
  timedOut: boolean;
  fallbackWarning: boolean;
  cancelled: boolean;
}

export interface InvokeOpts {
  spawnFn?: SpawnFn;
  signal?: AbortSignal;
  heartbeatMs?: number;
  onTick?: (elapsedMs: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** invoke の構造化版（MCP structuredContent 用）。判定は runChild の機械値を使う。 */
export async function invokeStructured(
  args: InvokeArgs,
  spawnFn: SpawnFn = defaultSpawn,
  invokeOpts: InvokeOpts = {},
): Promise<InvokeStructuredResult> {
  const fail = (output: string): InvokeStructuredResult => ({
    output,
    timedOut: false,
    fallbackWarning: false,
    cancelled: false,
  });
  const depth = Number(process.env[DEPTH_ENV] ?? "0");
  if (depth >= MAX_DEPTH) {
    return fail(
      `error: nested graphhopper_invoke refused (depth=${depth}). v1 forbids recursion.`,
    );
  }
  if (!Object.hasOwn(GRAPHHOPPER_AGENTS, args.agent)) {
    return fail(
      `error: unknown agent "${args.agent}". must be one of: ${Object.keys(GRAPHHOPPER_AGENTS).join(", ")}`,
    );
  }
  const model = resolveModel(args.root, args.agent, args.model);
  if (args.model && !validModel(args.model)) {
    return fail(
      `error: invalid model "${args.model}". must be provider/model without whitespace`,
    );
  }
  if (args.prompt.length > PROMPT_MAX_CHARS) {
    return fail(
      `error: prompt too long (${args.prompt.length} > ${PROMPT_MAX_CHARS}). split or use --file manually`,
    );
  }
  const binary = resolveBinary();
  if (!binary)
    return fail("error: opencode binary not found (PATH and known mise path)");
  const root = resolve(args.root);
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(MIN_TIMEOUT_MS, args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );
  const argv = buildArgs({ agent: args.agent, model, dir: root, title: "gh-invoke", prompt: args.prompt });
  const childEnv: NodeJS.ProcessEnv = { ...process.env, [DEPTH_ENV]: String(depth + 1) };
  // 壊れたbearerの混入防止: AWS_BEARER_TOKEN_BEDROCK は全認証手段より優先されるため、
  // 陳腐な値がsession envにあるとSSOプロファイルがshadowされてBedrock系が全滅する
  // （2026-09-28実証）。正規運用はSSOプロファイルのため子には渡さない
  delete childEnv["AWS_BEARER_TOKEN_BEDROCK"];
  // 起動ずらし（herd回避・opt-in）。中断済みならspawn前に諦める
  if (invokeOpts.signal?.aborted) {
    return {
      output: "error: invoke cancelled by client (before spawn)",
      timedOut: false,
      fallbackWarning: false,
      cancelled: true,
    };
  }
  const delayMs = Math.min(MAX_DELAY_MS, Math.max(0, args.delayMs ?? 0));
  if (delayMs > 0) await sleep(delayMs);
  if (invokeOpts.signal?.aborted) {
    return {
      output: "error: invoke cancelled by client (during delay)",
      timedOut: false,
      fallbackWarning: false,
      cancelled: true,
    };
  }
  const r = await runChild(
    binary,
    argv,
    {
      timeoutMs,
      cwd: root,
      childEnv,
      signal: invokeOpts.signal,
      heartbeatMs: invokeOpts.heartbeatMs,
      onTick: invokeOpts.onTick,
    },
    spawnFn,
  );
  return { output: r.output, timedOut: r.timedOut, fallbackWarning: r.fallbackWarning, cancelled: r.cancelled };
}
