const markdownImagePattern = /!\[[^\]\r\n]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/gi;
const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
const imageExtensionPattern = /\.(?:png|jpe?g|gif|webp)(?:[?#]|$)/i;
const windowsPathPattern =
  /[A-Za-z]:(?:\\|\/)(?:[^\\/:*?"<>|\r\n]+(?:\\|\/))*[^\\/:*?"<>|\r\n]*\.(?:png|jpe?g|gif|webp)/gi;
/** Absolute POSIX paths only at a token boundary so `mount:…/a.png` / `docs/a.png` are not sliced. */
const unixAbsPathPattern =
  /(?:^|[\s("'])(\/(?:[^\s<>"')\]]+)+\.(?:png|jpe?g|gif|webp))/gi;
const mountPathPattern =
  /mount:[a-z][a-z0-9-]{0,63}\/(?:[^\s<>"')\]]+)+\.(?:png|jpe?g|gif|webp)/gi;
/** Relative paths and bare filenames; directory segments are optional. */
const relativeOrBareImagePattern =
  /(?:\.{0,2}\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp)/gi;
/** file:// URIs pointing at local image paths (authority optional; Windows drive allowed). */
const fileUriPattern =
  /file:\/\/(?:localhost)?\/?(?:[A-Za-z]:)?(?:\/|\\)?[^\s<>"')\]]+\.(?:png|jpe?g|gif|webp)/gi;

export interface ImageUrlCandidate {
  readonly url: string;
  readonly start: number;
  readonly end: number;
  readonly explicit: boolean;
}

export interface ImagePathCandidate {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly explicit: boolean;
}

export type ImageInputCandidate =
  | ({ readonly kind: "url" } & ImageUrlCandidate)
  | ({ readonly kind: "path" } & ImagePathCandidate);

/**
 * Extract explicit Markdown images, standalone URLs, and embedded URLs with a known image extension.
 * HTTP MIME and magic-byte checks remain authoritative during ingestion.
 */
export function detectImageUrlCandidates(input: string): ImageUrlCandidate[] {
  const candidates = new Map<string, ImageUrlCandidate>();
  for (const match of input.matchAll(markdownImagePattern)) {
    const url = match[1];
    if (!url || match.index === undefined || !/^https?:\/\//i.test(url)) continue;
    const relative = match[0].indexOf(url);
    const start = match.index + relative;
    candidates.set(`${start}:${url}`, { url, start, end: start + url.length, explicit: true });
  }
  for (const match of input.matchAll(urlPattern)) {
    const url = match[0].replace(/[.,;:!?]+$/g, "");
    if (match.index === undefined) continue;
    const lineStart = input.lastIndexOf("\n", match.index - 1) + 1;
    const nextLineBreak = input.indexOf("\n", match.index + match[0].length);
    const lineEnd = nextLineBreak < 0 ? input.length : nextLineBreak;
    const standalone = input.slice(lineStart, lineEnd).trim() === url;
    if (!standalone && !imageExtensionPattern.test(url)) continue;
    const key = `${match.index}:${url}`;
    if (!candidates.has(key)) {
      candidates.set(key, {
        url,
        start: match.index,
        end: match.index + url.length,
        explicit: imageExtensionPattern.test(url) || standalone,
      });
    }
  }
  return [...candidates.values()].sort((left, right) => left.start - right.start);
}

/**
 * Extract local image path candidates: Markdown local images, Windows/Unix absolute paths,
 * `file://` URIs, `mount:<id>/…` paths, relative paths, and bare filenames with a known image
 * extension (including when embedded in prose such as Chinese task text).
 * Workspace containment and magic-byte checks remain authoritative during ingestion.
 */
export function detectImagePathCandidates(input: string): ImagePathCandidate[] {
  const candidates = new Map<string, ImagePathCandidate>();

  const add = (path: string, start: number, end: number, explicit: boolean): void => {
    const normalized = path.replace(/[.,;:!?]+$/g, "");
    if (!normalized || /^https?:\/\//i.test(normalized) || !imageExtensionPattern.test(normalized)) {
      return;
    }
    const key = `${start}:${normalized}`;
    if (!candidates.has(key)) {
      candidates.set(key, {
        path: normalized,
        start,
        end,
        explicit,
      });
    }
  };

  for (const match of input.matchAll(markdownImagePattern)) {
    const path = match[1];
    if (!path || match.index === undefined || /^https?:\/\//i.test(path)) continue;
    if (/^file:/i.test(path)) {
      const decoded = decodeFileUri(path);
      if (!decoded) continue;
      const relative = match[0].indexOf(path);
      add(decoded, match.index + relative, match.index + relative + path.length, true);
      continue;
    }
    const relative = match[0].indexOf(path);
    add(path, match.index + relative, match.index + relative + path.length, true);
  }

  for (const match of input.matchAll(fileUriPattern)) {
    if (match.index === undefined) continue;
    const decoded = decodeFileUri(match[0]);
    if (!decoded) continue;
    add(decoded, match.index, match.index + match[0].length, true);
  }

  for (const match of input.matchAll(windowsPathPattern)) {
    if (match.index === undefined) continue;
    add(match[0], match.index, match.index + match[0].length, true);
  }
  for (const match of input.matchAll(unixAbsPathPattern)) {
    const path = match[1];
    if (!path || match.index === undefined) continue;
    const start = match[0].startsWith("/") ? match.index : match.index + 1;
    add(path, start, start + path.length, true);
  }
  for (const match of input.matchAll(mountPathPattern)) {
    if (match.index === undefined) continue;
    add(match[0], match.index, match.index + match[0].length, true);
  }

  for (const match of input.matchAll(relativeOrBareImagePattern)) {
    if (match.index === undefined) continue;
    const path = match[0];
    if (/^[A-Za-z]:/.test(path) || path.startsWith("mount:") || path.startsWith("/")) continue;
    if (isEmbeddedInHttpUrl(input, match.index)) continue;
    if (!isPathTokenBoundary(input, match.index, match.index + path.length)) continue;
    add(path, match.index, match.index + path.length, true);
  }

  return collapseOverlappingPathCandidates(
    [...candidates.values()].sort((left, right) => left.start - right.start || right.end - left.end),
  );
}

/** Prefer earlier, longer spans so absolute/`file://`/`mount:` wins over bare basename slices. */
function collapseOverlappingPathCandidates(
  ordered: readonly ImagePathCandidate[],
): ImagePathCandidate[] {
  const accepted: ImagePathCandidate[] = [];
  let cursor = 0;
  for (const candidate of ordered) {
    if (candidate.start < cursor) continue;
    accepted.push(candidate);
    cursor = candidate.end;
  }
  return accepted;
}

/** Merge URL and path candidates in input order; overlapping ranges prefer the earlier / URL match. */
export function detectImageInputCandidates(input: string): ImageInputCandidate[] {
  const merged: ImageInputCandidate[] = [
    ...detectImageUrlCandidates(input).map((candidate) => ({ kind: "url" as const, ...candidate })),
    ...detectImagePathCandidates(input).map((candidate) => ({ kind: "path" as const, ...candidate })),
  ].sort((left, right) => left.start - right.start || (left.kind === "url" ? -1 : 1));

  const accepted: ImageInputCandidate[] = [];
  let cursor = 0;
  for (const candidate of merged) {
    if (candidate.start < cursor) continue;
    accepted.push(candidate);
    cursor = candidate.end;
  }
  return accepted;
}

/** Convert a file:// URI into a filesystem path suitable for Workspace/mount resolution. */
export function decodeFileUri(value: string): string | undefined {
  const trimmed = value.trim().replace(/[.,;:!?]+$/g, "");
  if (!/^file:/i.test(trimmed)) return undefined;
  let body: string;
  try {
    body = decodeURIComponent(trimmed.replace(/^file:\/\//i, ""));
  } catch {
    return undefined;
  }
  body = body.replace(/^localhost\//i, "");
  if (/^[A-Za-z]\|\//.test(body)) {
    // Rare `file:///C|/Users/...` form
    body = `${body[0]}:${body.slice(2)}`;
  }
  if (/^[A-Za-z]:/.test(body)) {
    return body.replaceAll("/", "\\");
  }
  if (body.startsWith("/") && /^\/[A-Za-z]:/.test(body)) {
    // `file:///C:/Users/...` → `/C:/Users/...` → `C:/Users/...`
    return body.slice(1).replaceAll("/", "\\");
  }
  if (!body.startsWith("/")) body = `/${body}`;
  return body;
}

function isEmbeddedInHttpUrl(input: string, start: number): boolean {
  const lookbehind = input.slice(Math.max(0, start - 16), start).toLowerCase();
  return /https?:\/\/\S*$/i.test(lookbehind);
}

function isPathTokenBoundary(input: string, start: number, end: number): boolean {
  if (start > 0) {
    const before = input[start - 1]!;
    if (/[A-Za-z0-9._-]/.test(before)) return false;
  }
  if (end < input.length) {
    const after = input[end]!;
    if (/[A-Za-z0-9._-]/.test(after)) return false;
  }
  return true;
}
