import { parse } from "yaml";

export interface ParsedMarkdown<T extends Record<string, unknown>> {
  metadata: T;
  body: string;
}

export function parseFrontmatter<T extends Record<string, unknown>>(content: string, label: string): ParsedMarkdown<T> {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    throw new TypeError(`${label} must begin with YAML frontmatter`);
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match?.[1]) throw new TypeError(`${label} has unterminated or empty frontmatter`);
  const metadata = parse(match[1]) as unknown;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new TypeError(`${label} frontmatter must be a mapping`);
  }
  return { metadata: metadata as T, body: content.slice(match[0].length) };
}

export function requireString(value: unknown, field: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label}.${field} must be a non-empty string`);
  return value.trim();
}
