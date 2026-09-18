/** LSP自前最小実装の型（OmOコードの持ち込みなし・公開LSP仕様に基づく）。 */

export interface LspPosition {
  /** 0-based line */
  line: number;
  /** 0-based character */
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspHover {
  contents: string;
  range: LspRange | null;
}

export interface LspSymbol {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspServerDef {
  command: string;
  args: string[];
  extensions: string[];
}

/** tool境界は1-based、client内部は0-basedに変換する。 */
export function toZeroBased(line1: number, col1: number): LspPosition {
  return { line: Math.max(0, line1 - 1), character: Math.max(0, col1 - 1) };
}

export function toOneBased(pos: LspPosition): { line: number; col: number } {
  return { line: pos.line + 1, col: pos.character + 1 };
}

export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) return decodeURIComponent(uri.slice("file://".length));
  return uri;
}

export function pathToUri(path: string): string {
  const abs = path.startsWith("/") ? path : `/${path}`;
  return `file://${encodeURIComponent(abs).replace(/%2F/g, "/")}`;
}
