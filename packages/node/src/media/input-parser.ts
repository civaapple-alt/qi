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
const relativePathPattern =
  /(?:\.{0,2}\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp)/gi;

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
 * `mount:<id>/…` paths, and standalone relative paths with a known image extension.
 * Workspace containment and magic-byte checks remain authoritative during ingestion.
 */
export function detectImagePathCandidates(input: string): ImagePathCandidate[] {
  const candidates = new Map<string, ImagePathCandidate>();

  const add = (path: string, start: number, explicit: boolean): void => {
    const normalized = path.replace(/[.,;:!?]+$/g, "");
    if (!normalized || /^https?:\/\//i.test(normalized) || !imageExtensionPattern.test(normalized)) {
      return;
    }
    const key = `${start}:${normalized}`;
    if (!candidates.has(key)) {
      candidates.set(key, {
        path: normalized,
        start,
        end: start + normalized.length,
        explicit,
      });
    }
  };

  for (const match of input.matchAll(markdownImagePattern)) {
    const path = match[1];
    if (!path || match.index === undefined || /^https?:\/\//i.test(path)) continue;
    const relative = match[0].indexOf(path);
    add(path, match.index + relative, true);
  }

  for (const match of input.matchAll(windowsPathPattern)) {
    if (match.index === undefined) continue;
    add(match[0], match.index, true);
  }
  for (const match of input.matchAll(unixAbsPathPattern)) {
    const path = match[1];
    if (!path || match.index === undefined) continue;
    const start = match[0].startsWith("/") ? match.index : match.index + 1;
    add(path, start, true);
  }
  for (const match of input.matchAll(mountPathPattern)) {
    if (match.index === undefined) continue;
    add(match[0], match.index, true);
  }

  for (const match of input.matchAll(relativePathPattern)) {
    if (match.index === undefined) continue;
    const path = match[0];
    if (/^[A-Za-z]:/.test(path) || path.startsWith("mount:") || path.startsWith("/")) continue;
    const lineStart = input.lastIndexOf("\n", match.index - 1) + 1;
    const nextLineBreak = input.indexOf("\n", match.index + match[0].length);
    const lineEnd = nextLineBreak < 0 ? input.length : nextLineBreak;
    const standalone = input.slice(lineStart, lineEnd).trim() === path;
    if (!standalone) continue;
    add(path, match.index, true);
  }

  return [...candidates.values()].sort((left, right) => left.start - right.start);
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
