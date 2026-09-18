/**
 * LSP JSON-RPC over stdio 最小クライアント（自前実装・公開LSP仕様に基づく）。
 * 対応: initialize / hover / definition / references / documentSymbol /
 * workspaceSymbol / didOpen→publishDiagnostics待機→didClose / shutdown。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import type {
  LspDiagnostic,
  LspHover,
  LspLocation,
  LspPosition,
  LspServerDef,
  LspSymbol,
} from "./types";
import { pathToUri } from "./types";

const IDLE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DIAGNOSTICS_WAIT_MS = 3000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function findWorkspaceRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (existsSync(`${dir}/.jj`) || existsSync(`${dir}/.git`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir);
}

export function resolveRootForFile(filePath: string): string {
  return findWorkspaceRoot(dirname(resolve(filePath)));
}

function encode(msg: object): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

export class LSPClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = Buffer.alloc(0);
  private notifications: { method: string; params: unknown }[] = [];
  private diagWaiters: ((d: unknown) => void)[] = [];
  private opened = new Set<string>();
  readonly key: string;

  constructor(
    readonly root: string,
    readonly server: LspServerDef,
  ) {
    this.key = `${root}::${server.command}`;
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const proc = spawn(this.server.command, this.server.args, {
      cwd: this.root,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.proc = proc;
    this.buf = Buffer.alloc(0);
    proc.stdout?.on("data", (c: Buffer) => this.onData(c));
    proc.on("error", (e) => this.failAll(e instanceof Error ? e : new Error(String(e))));
    proc.on("exit", () => this.failAll(new Error(`LSP server exited: ${this.server.command}`)));
    const resp = await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToUri(this.root),
      capabilities: {},
    });
    void resp;
    this.notify("initialized", {});
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      try {
        this.onMessage(JSON.parse(body) as Record<string, unknown>);
      } catch {
        // 不正JSONは捨てる
      }
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    if (typeof msg["id"] === "number" && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(msg["id"] as number);
      if (!p) return;
      this.pending.delete(msg["id"] as number);
      clearTimeout(p.timer);
      if ("error" in msg) {
        p.reject(new Error(`LSP error: ${JSON.stringify(msg["error"])}`));
      } else {
        p.resolve(msg["result"]);
      }
      return;
    }
    const method = msg["method"];
    if (typeof method === "string") {
      this.notifications.push({ method, params: msg["params"] });
      if (method === "textDocument/publishDiagnostics") {
        const waiters = this.diagWaiters.splice(0);
        for (const w of waiters) w(msg["params"]);
      }
      // サーバ→クライアント要求には空応答（shutdown要求等への最小応答）
      if (typeof msg["id"] === "number" || typeof msg["id"] === "string") {
        this.send({ jsonrpc: "2.0", id: msg["id"], result: null });
      }
    }
  }

  private send(msg: object): void {
    this.proc?.stdin?.write(encode(msg));
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.running) return Promise.reject(new Error("LSP client not running"));
    const id = this.nextId++;
    return new Promise<unknown>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** 照会前にdidOpen（未open時の空応答対策）。失敗・読めない場合は黙って進む。 */
  private ensureOpen(filePath: string): void {
    const uri = pathToUri(resolve(filePath));
    if (this.opened.has(uri) || !this.running) return;
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    const i = filePath.lastIndexOf(".");
    const ext = i >= 0 ? filePath.slice(i).toLowerCase() : "";
    const languageId =
      ext === ".py" ? "python" : ext === ".rs" ? "rust" : ext === ".go" ? "go"
      : ext === ".ts" || ext === ".tsx" ? "typescript" : "plaintext";
    try {
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      this.opened.add(uri);
    } catch {
      // didOpen失敗は照会を止めない
    }
  }

  async hover(filePath: string, pos: LspPosition): Promise<LspHover | null> {
    this.ensureOpen(filePath);
    const r = (await this.request("textDocument/hover", {
      textDocument: { uri: pathToUri(resolve(filePath)) },
      position: pos,
    })) as null | { contents: unknown; range?: unknown };
    if (!r || r.contents == null) return null;
    const text = hoverContentsToString(r.contents);
    if (!text) return null;
    return { contents: text, range: (r.range as LspHover["range"]) ?? null };
  }

  async definition(filePath: string, pos: LspPosition): Promise<LspLocation[]> {
    this.ensureOpen(filePath);
    const r = await this.request("textDocument/definition", {
      textDocument: { uri: pathToUri(resolve(filePath)) },
      position: pos,
    });
    return normalizeLocations(r);
  }

  async references(filePath: string, pos: LspPosition): Promise<LspLocation[]> {
    this.ensureOpen(filePath);
    const r = await this.request("textDocument/references", {
      textDocument: { uri: pathToUri(resolve(filePath)) },
      position: pos,
      context: { includeDeclaration: true },
    });
    return normalizeLocations(r);
  }

  async documentSymbols(filePath: string): Promise<LspSymbol[]> {
    this.ensureOpen(filePath);
    const r = await this.request("textDocument/documentSymbol", {
      textDocument: { uri: pathToUri(resolve(filePath)) },
    });
    return normalizeSymbols(r);
  }

  async workspaceSymbols(query: string): Promise<LspSymbol[]> {
    const r = await this.request("workspace/symbol", { query });
    return normalizeSymbols(r);
  }

  /** didOpen→publishDiagnostics待機（timeout後は空）→didClose */
  async diagnostics(filePath: string, text: string, languageId: string): Promise<LspDiagnostic[]> {
    const uri = pathToUri(resolve(filePath));
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
    const got = await new Promise<unknown>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(null), DIAGNOSTICS_WAIT_MS);
      this.diagWaiters.push((d) => {
        clearTimeout(timer);
        resolvePromise(d);
      });
    });
    this.notify("textDocument/didClose", { textDocument: { uri } });
    if (!got || typeof got !== "object") return [];
    const diags = (got as { diagnostics?: unknown }).diagnostics;
    return Array.isArray(diags) ? (diags as LspDiagnostic[]) : [];
  }

  async stop(): Promise<void> {
    try {
      for (const uri of this.opened) {
        try {
          this.notify("textDocument/didClose", { textDocument: { uri } });
        } catch {
          // 1件のclose失敗で他を止めない
        }
      }
      this.opened.clear();
      if (this.running) {
        this.send({ jsonrpc: "2.0", id: this.nextId++, method: "shutdown", params: null });
        this.notify("exit", null);
      }
    } catch {
      // 停止失敗は無視
    }
    this.proc?.kill();
    this.proc = null;
    this.failAll(new Error("LSP client stopped"));
  }
}

function hoverContentsToString(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(hoverContentsToString).filter(Boolean).join("\n");
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    if (typeof o["value"] === "string") return o["value"] as string;
    if (typeof o["kind"] === "string" && typeof o["value"] === "string")
      return o["value"] as string;
  }
  return "";
}

function normalizeLocations(r: unknown): LspLocation[] {
  if (!r) return [];
  const arr = Array.isArray(r) ? r : [r];
  const out: LspLocation[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    // Location | LocationLink
    const uri = typeof o["uri"] === "string" ? (o["uri"] as string)
      : typeof o["targetUri"] === "string" ? (o["targetUri"] as string) : null;
    const range = (o["range"] ?? o["targetSelectionRange"] ?? o["targetRange"]) as
      | LspLocation["range"] | undefined;
    if (uri && range) out.push({ uri, range });
  }
  return out;
}

function normalizeSymbols(r: unknown): LspSymbol[] {
  if (!Array.isArray(r)) return [];
  const out: LspSymbol[] = [];
  const walk = (items: unknown[]): void => {
    for (const e of items) {
      if (!e || typeof e !== "object") continue;
      const o = e as Record<string, unknown>;
      if (typeof o["name"] === "string" && (o["location"] || o["range"])) {
        const loc = (o["location"] ?? {
          uri: "",
          range: o["range"],
          selectionRange: o["selectionRange"],
        }) as LspLocation;
        out.push({
          name: o["name"] as string,
          kind: typeof o["kind"] === "number" ? (o["kind"] as number) : 0,
          location: loc,
          containerName: typeof o["containerName"] === "string" ? (o["containerName"] as string) : undefined,
        });
      }
      if (Array.isArray(o["children"])) walk(o["children"] as unknown[]);
    }
  };
  walk(r);
  return out;
}

class Manager {
  private clients = new Map<string, { client: LSPClient; lastUsed: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.clients) {
      if (now - v.lastUsed > IDLE_MS) {
        void v.client.stop();
        this.clients.delete(k);
      }
    }
    if (this.clients.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensureSweep(): void {
    if (!this.timer) this.timer = setInterval(() => this.sweep(), 15_000);
  }

  async getClient(root: string, server: LspServerDef): Promise<LSPClient> {
    const key = `${root}::${server.command}`;
    const hit = this.clients.get(key);
    if (hit && hit.client.running) {
      hit.lastUsed = Date.now();
      return hit.client;
    }
    if (hit) this.clients.delete(key);
    const client = new LSPClient(root, server);
    await client.start();
    this.clients.set(key, { client, lastUsed: Date.now() });
    this.ensureSweep();
    return client;
  }

  release(client: LSPClient): void {
    const hit = this.clients.get(client.key);
    if (hit) hit.lastUsed = Date.now();
  }

  async stopAll(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.all(all.map((v) => v.client.stop()));
  }
}

export const LSPServerManager = new Manager();

export function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
