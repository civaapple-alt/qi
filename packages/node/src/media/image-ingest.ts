import sharp, { type Metadata, type OutputInfo, type Sharp } from "sharp";
import type { ArtifactStore } from "@civaapple/qi-agent/tools";
import { ToolFailure } from "@civaapple/qi-agent/tools";
import type { RunImagePart } from "@civaapple/qi-protocol";
import {
  readPublicNetworkResource,
  type NetworkFetchDependencies,
} from "../tools/network.js";

export const DEFAULT_IMAGE_MAX_EDGE_PX = 2_000;
export const DEFAULT_IMAGE_BYTE_BUDGET = Math.floor(3.75 * 1024 * 1024);
export const DEFAULT_READ_IMAGE_BYTE_BUDGET = 262_144;
export const MAX_IMAGE_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_DECODE_PIXELS = 100_000_000;
export const MAX_IMAGES_PER_INPUT = 8;
export const MAX_PREPARED_IMAGE_BYTES_PER_INPUT = 20 * 1024 * 1024;

export type SupportedImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

export interface ImageIngestOptions {
  readonly artifactStore: ArtifactStore;
  readonly maxEdgePx?: number;
  readonly byteBudget?: number;
  readonly maxSourceBytes?: number;
  readonly maxDecodePixels?: number;
}

export interface IngestImageBytesInput {
  readonly bytes: Uint8Array;
  readonly source: "clipboard" | "url" | "path";
  readonly declaredMediaType?: string;
}

export interface IngestImageUrlOptions {
  readonly networkAuthorized: boolean;
  readonly signal?: AbortSignal;
  readonly dependencies?: NetworkFetchDependencies;
}

export interface PreparedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: SupportedImageMediaType;
  readonly originalMediaType: SupportedImageMediaType;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly width: number;
  readonly height: number;
  readonly downsampled: boolean;
  readonly formatChanged: boolean;
  readonly orientationApplied: boolean;
}

export class ImageIngestService {
  readonly #artifactStore: ArtifactStore;
  readonly #maxEdgePx: number;
  readonly #byteBudget: number;
  readonly #maxSourceBytes: number;
  readonly #maxDecodePixels: number;

  constructor(options: ImageIngestOptions) {
    this.#artifactStore = options.artifactStore;
    this.#maxEdgePx = positiveInteger(options.maxEdgePx ?? DEFAULT_IMAGE_MAX_EDGE_PX, "maxEdgePx");
    this.#byteBudget = positiveInteger(options.byteBudget ?? DEFAULT_IMAGE_BYTE_BUDGET, "byteBudget");
    this.#maxSourceBytes = positiveInteger(options.maxSourceBytes ?? MAX_IMAGE_SOURCE_BYTES, "maxSourceBytes");
    this.#maxDecodePixels = positiveInteger(
      options.maxDecodePixels ?? MAX_IMAGE_DECODE_PIXELS,
      "maxDecodePixels",
    );
  }

  async ingestBytes(input: IngestImageBytesInput): Promise<RunImagePart> {
    const prepared = await prepareImageBytes(input.bytes, {
      maxEdgePx: this.#maxEdgePx,
      byteBudget: this.#byteBudget,
      maxSourceBytes: this.#maxSourceBytes,
      maxDecodePixels: this.#maxDecodePixels,
      ...(input.declaredMediaType === undefined ? {} : { declaredMediaType: input.declaredMediaType }),
    });
    const [original, final] = await Promise.all([
      this.#artifactStore.put(input.bytes, prepared.originalMediaType),
      this.#artifactStore.put(prepared.bytes, prepared.mediaType),
    ]);
    return {
      type: "image",
      source: input.source,
      originalArtifactRef: original.ref,
      preparedArtifactRef: final.ref,
      originalMediaType: prepared.originalMediaType,
      mediaType: prepared.mediaType,
      originalByteLength: input.bytes.byteLength,
      byteLength: prepared.bytes.byteLength,
      originalWidth: prepared.originalWidth,
      originalHeight: prepared.originalHeight,
      width: prepared.width,
      height: prepared.height,
      downsampled: prepared.downsampled,
      formatChanged: prepared.formatChanged,
      orientationApplied: prepared.orientationApplied,
    };
  }

  async ingestUrl(url: string, options: IngestImageUrlOptions): Promise<RunImagePart> {
    if (!options.networkAuthorized) {
      throw new ToolFailure(
        "AUTHORITY_DENIED",
        "Image URL ingestion requires an active Network capability",
      );
    }
    const resource = await readPublicNetworkResource(
      url,
      {
        maxBytes: this.#maxSourceBytes,
        accept: "image/png, image/jpeg, image/gif, image/webp",
      },
      options.dependencies,
      options.signal,
    );
    const declaredMediaType = normalizeImageMediaType(resource.mediaType);
    if (declaredMediaType === undefined) {
      throw new ToolFailure(
        "IMAGE_HTTP_MEDIA_TYPE",
        `Image URL returned unsupported HTTP content type ${resource.mediaType}`,
      );
    }
    return this.ingestBytes({
      bytes: resource.body,
      source: "url",
      declaredMediaType,
    });
  }
}

export async function prepareImageBytes(
  bytes: Uint8Array,
  options: {
    readonly maxEdgePx?: number;
    readonly byteBudget?: number;
    readonly maxSourceBytes?: number;
    readonly maxDecodePixels?: number;
    readonly declaredMediaType?: string;
  } = {},
): Promise<PreparedImage> {
  const maxEdgePx = positiveInteger(options.maxEdgePx ?? DEFAULT_IMAGE_MAX_EDGE_PX, "maxEdgePx");
  const byteBudget = positiveInteger(options.byteBudget ?? DEFAULT_IMAGE_BYTE_BUDGET, "byteBudget");
  const maxSourceBytes = positiveInteger(
    options.maxSourceBytes ?? MAX_IMAGE_SOURCE_BYTES,
    "maxSourceBytes",
  );
  const maxDecodePixels = positiveInteger(
    options.maxDecodePixels ?? MAX_IMAGE_DECODE_PIXELS,
    "maxDecodePixels",
  );
  if (bytes.byteLength === 0) throw new ToolFailure("IMAGE_EMPTY", "Image is empty");
  if (bytes.byteLength > maxSourceBytes) {
    throw new ToolFailure("IMAGE_SOURCE_TOO_LARGE", `Image exceeds ${maxSourceBytes} source bytes`);
  }
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === undefined) {
    throw new ToolFailure("IMAGE_FORMAT_UNSUPPORTED", "Image magic bytes are not PNG, JPEG, GIF, or WebP");
  }
  const declared = options.declaredMediaType === undefined
    ? undefined
    : normalizeImageMediaType(options.declaredMediaType);
  if (options.declaredMediaType !== undefined && declared === undefined) {
    throw new ToolFailure("IMAGE_MEDIA_TYPE_UNSUPPORTED", `Unsupported declared media type ${options.declaredMediaType}`);
  }
  if (declared !== undefined && declared !== mediaType) {
    throw new ToolFailure(
      "IMAGE_MEDIA_TYPE_MISMATCH",
      `Declared image type ${declared} does not match ${mediaType} magic bytes`,
    );
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, {
      animated: true,
      failOn: "error",
      limitInputPixels: maxDecodePixels,
    }).metadata();
  } catch (error) {
    throw new ToolFailure("IMAGE_DECODE_FAILED", `Image could not be decoded: ${errorMessage(error)}`);
  }
  const originalWidth = metadata.width ?? 0;
  const originalHeight = metadata.height ?? 0;
  if (originalWidth <= 0 || originalHeight <= 0) {
    throw new ToolFailure("IMAGE_DIMENSIONS_INVALID", "Image dimensions are unavailable");
  }
  if (originalWidth * originalHeight > maxDecodePixels) {
    throw new ToolFailure("IMAGE_PIXEL_LIMIT", `Image exceeds ${maxDecodePixels} decoded pixels`);
  }
  const animated = (mediaType === "image/gif" || mediaType === "image/webp") &&
    (metadata.pages ?? 1) > 1;
  const orientationApplied = (metadata.orientation ?? 1) !== 1;
  const longestEdge = Math.max(originalWidth, originalHeight);
  if (animated) {
    if (bytes.byteLength <= byteBudget && longestEdge <= maxEdgePx) {
      return {
        bytes,
        mediaType,
        originalMediaType: mediaType,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        downsampled: false,
        formatChanged: false,
        orientationApplied: false,
      };
    }
    throw new ToolFailure(
      "IMAGE_ANIMATION_TOO_LARGE",
      "Animated GIF/WebP must already satisfy image byte and dimension limits",
    );
  }
  if (bytes.byteLength <= byteBudget && longestEdge <= maxEdgePx && !orientationApplied) {
    return {
      bytes,
      mediaType,
      originalMediaType: mediaType,
      originalWidth,
      originalHeight,
      width: originalWidth,
      height: originalHeight,
      downsampled: false,
      formatChanged: false,
      orientationApplied: false,
    };
  }

  const hasAlpha = metadata.hasAlpha === true;
  const preserveLossless = hasAlpha || mediaType === "image/png";
  const edges = [...new Set([
    Math.min(maxEdgePx, longestEdge),
    1_500,
    1_000,
    768,
    512,
    384,
    256,
  ].filter((edge) => edge > 0 && edge <= Math.min(maxEdgePx, longestEdge)))];
  let smallest:
    | { bytes: Uint8Array; mediaType: SupportedImageMediaType; width: number; height: number }
    | undefined;

  const consider = (
    candidate: { data: Buffer; info: OutputInfo },
    candidateMediaType: SupportedImageMediaType,
  ): PreparedImage | undefined => {
    if (smallest === undefined || candidate.data.byteLength < smallest.bytes.byteLength) {
      smallest = {
        bytes: candidate.data,
        mediaType: candidateMediaType,
        width: candidate.info.width,
        height: candidate.info.height,
      };
    }
    if (candidate.data.byteLength > byteBudget) return undefined;
    return {
      bytes: candidate.data,
      mediaType: candidateMediaType,
      originalMediaType: mediaType,
      originalWidth,
      originalHeight,
      width: candidate.info.width,
      height: candidate.info.height,
      downsampled: candidate.info.width < originalWidth || candidate.info.height < originalHeight,
      formatChanged: candidateMediaType !== mediaType,
      orientationApplied,
    };
  };

  for (const edge of edges) {
    if (preserveLossless) {
      const png = await imagePipeline(bytes, edge, maxDecodePixels)
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer({ resolveWithObject: true });
      const accepted = consider(png, "image/png");
      if (accepted !== undefined) return accepted;
      if (hasAlpha) continue;
    }
    for (const quality of [80, 60, 40, 20] as const) {
      const jpeg = await imagePipeline(bytes, edge, maxDecodePixels)
        .jpeg({ quality, progressive: true, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      const accepted = consider(jpeg, "image/jpeg");
      if (accepted !== undefined) return accepted;
    }
  }
  throw new ToolFailure(
    "IMAGE_PREPARED_TOO_LARGE",
    `Image cannot be prepared within ${byteBudget} bytes${smallest ? `; smallest was ${smallest.bytes.byteLength}` : ""}`,
  );
}

export function sniffImageMediaType(bytes: Uint8Array): SupportedImageMediaType | undefined {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const signature = ascii(bytes, 0, 6);
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  return undefined;
}

export function normalizeImageMediaType(value: string): SupportedImageMediaType | undefined {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return normalized === "image/png" || normalized === "image/jpeg" ||
    normalized === "image/gif" || normalized === "image/webp"
    ? normalized
    : undefined;
}

function imagePipeline(bytes: Uint8Array, edge: number, limitInputPixels: number): Sharp {
  return sharp(bytes, { failOn: "error", limitInputPixels })
    .rotate()
    .resize({
      width: edge,
      height: edge,
      fit: "inside",
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
    });
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
