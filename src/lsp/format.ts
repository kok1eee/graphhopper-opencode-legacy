/** tool結果の整形（文字列返却コントラクト）。 */
import { MAX_RESULTS } from "./config";
import { toOneBased, uriToPath } from "./types";
import type { LspDiagnostic, LspHover, LspLocation, LspSymbol } from "./types";

function fmtLoc(l: LspLocation): string {
  const p = toOneBased(l.range.start);
  return `${uriToPath(l.uri)}:${p.line}:${p.col}`;
}

function truncateNote(total: number): string {
  return total > MAX_RESULTS ? `\n... (${MAX_RESULTS}件で打切り・全${total}件)` : "";
}

export function formatHover(h: LspHover | null): string {
  if (!h || !h.contents.trim()) return "No hover found";
  return h.contents.length > 4000 ? `${h.contents.slice(0, 4000)}\n... (truncated)` : h.contents;
}

export function formatLocations(title: string, locs: LspLocation[]): string {
  if (locs.length === 0) return `No ${title} found`;
  const shown = locs.slice(0, MAX_RESULTS);
  return `${shown.map(fmtLoc).join("\n")}${truncateNote(locs.length)}`;
}

export function formatSymbols(symbols: LspSymbol[]): string {
  if (symbols.length === 0) return "No symbols found";
  const shown = symbols.slice(0, MAX_RESULTS);
  const lines = shown.map((s) => {
    const loc = s.location?.uri ? fmtLoc(s.location) : "(no location)";
    return `${s.name} [${s.kind}] ${s.containerName ?? ""} ${loc}`.trim();
  });
  return `${lines.join("\n")}${truncateNote(symbols.length)}`;
}

export function formatDiagnostics(diags: LspDiagnostic[]): string {
  if (diags.length === 0) return "No diagnostics found";
  const shown = diags.slice(0, MAX_RESULTS);
  const sev = (s?: number): string =>
    s === 1 ? "error" : s === 2 ? "warning" : s === 3 ? "info" : s === 4 ? "hint" : "diag";
  const lines = shown.map((d) => {
    const p = toOneBased(d.range.start);
    return `${p.line}:${p.col} [${sev(d.severity)}${d.source ? `:${d.source}` : ""}] ${d.message}`;
  });
  return `${lines.join("\n")}${truncateNote(diags.length)}`;
}
