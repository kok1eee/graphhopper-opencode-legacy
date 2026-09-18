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
}

/** 子プロセス実行（seam付き・group kill対応）。 */
export function runChild(
  binary: string,
  args: string[],
  opts: { timeoutMs: number; cwd: string; childEnv: NodeJS.ProcessEnv },
  spawnFn: SpawnFn = defaultSpawn,
): Promise<InvokeResult> {
  return new Promise((resolvePromise) => {
    const child = spawnFn(binary, args, {
      cwd: opts.cwd,
      env: opts.childEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (timedOut: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      const fallbackWarning = /Falling back to default agent/.test(stderr);
      let output = truncate(stdout, STDOUT_MAX_CHARS);
      if (timedOut) {
        output += `\nerror: invoke timeout after ${opts.timeoutMs}ms (killed; orphaned child may continue billing)`;
      } else if (code !== 0) {
        const tail = stderr.split("\n").slice(-20).join("\n");
        output += `\nerror: opencode run exited with code ${code}\n${tail}`;
      }
      if (fallbackWarning) {
        output += `\nwarning: agent fell back to default (read-only not enforced by agent def)`;
      }
      resolvePromise({ output, timedOut, fallbackWarning });
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
    const timer = setTimeout(() => {
      killGroup("SIGTERM");
      graceTimer = setTimeout(() => {
        killGroup("SIGKILL");
        finish(true);
      }, KILL_GRACE_MS);
    }, opts.timeoutMs);
  });
}

/** graphhopper_invoke 本体。成功・失敗すべて文字列で返す。 */
export async function invoke(
  args: InvokeArgs,
  spawnFn: SpawnFn = defaultSpawn,
): Promise<string> {
  const depth = Number(process.env[DEPTH_ENV] ?? "0");
  if (depth >= MAX_DEPTH) {
    return `error: nested graphhopper_invoke refused (depth=${depth}). v1 forbids recursion.`;
  }
  if (!Object.hasOwn(GRAPHHOPPER_AGENTS, args.agent)) {
    return `error: unknown agent "${args.agent}". must be one of: ${Object.keys(GRAPHHOPPER_AGENTS).join(", ")}`;
  }
  const model = resolveModel(args.root, args.agent, args.model);
  if (args.model && !validModel(args.model)) {
    return `error: invalid model "${args.model}". must be provider/model without whitespace`;
  }
  if (args.prompt.length > PROMPT_MAX_CHARS) {
    return `error: prompt too long (${args.prompt.length} > ${PROMPT_MAX_CHARS}). split or use --file manually`;
  }
  const binary = resolveBinary();
  if (!binary) return "error: opencode binary not found (PATH and known mise path)";
  const root = resolve(args.root);
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(MIN_TIMEOUT_MS, args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );
  const argv = buildArgs({ agent: args.agent, model, dir: root, title: "gh-invoke", prompt: args.prompt });
  const childEnv: NodeJS.ProcessEnv = { ...process.env, [DEPTH_ENV]: String(depth + 1) };
  const r = await runChild(binary, argv, { timeoutMs, cwd: root, childEnv }, spawnFn);
  return r.output;
}
