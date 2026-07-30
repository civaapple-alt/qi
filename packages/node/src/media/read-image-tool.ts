import { createHash } from "node:crypto";
import sharp from "sharp";
import { Type } from "@sinclair/typebox";
import { ToolFailure, defineTool } from "@civaapple/qi-agent/tools";
import {
  DEFAULT_READ_IMAGE_BYTE_BUDGET,
  MAX_IMAGE_DECODE_PIXELS,
  normalizeImageMediaType,
  sniffImageMediaType,
} from "./image-ingest.js";

export interface ReadImageToolOptions {
  readonly getAllowedOriginalRefs: (sessionId: string) => ReadonlySet<string>;
  readonly byteBudget?: number;
  readonly maxEdgePx?: number;
}

export function createReadImageTool(options: ReadImageToolOptions) {
  const byteBudget = positiveInteger(
    options.byteBudget ?? DEFAULT_READ_IMAGE_BYTE_BUDGET,
    "byteBudget",
  );
  const maxEdgePx = positiveInteger(options.maxEdgePx ?? 2_000, "maxEdgePx");
  return defineTool({
    description: "Read a bounded full-resolution view or crop from an original image attached to this Session. Coordinates refer to the auto-oriented original image. Returns a derived image Artifact for visual inspection.",
    input: Type.Object(
      {
        artifactRef: Type.String({ pattern: "^artifact://[a-f0-9]{64}$" }),
        region: Type.Optional(Type.Object(
          {
            x: Type.Integer({ minimum: 0 }),
            y: Type.Integer({ minimum: 0 }),
            width: Type.Integer({ minimum: 1 }),
            height: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        )),
      },
      { additionalProperties: false },
    ),
    output: Type.Object(
      {
        artifactRef: Type.String({ pattern: "^artifact://[a-f0-9]{64}$" }),
        mediaType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg")]),
        byteLength: Type.Integer({ minimum: 1 }),
        width: Type.Integer({ minimum: 1 }),
        height: Type.Integer({ minimum: 1 }),
        originalWidth: Type.Integer({ minimum: 1 }),
        originalHeight: Type.Integer({ minimum: 1 }),
        resized: Type.Boolean(),
        region: Type.Object(
          {
            x: Type.Integer({ minimum: 0 }),
            y: Type.Integer({ minimum: 0 }),
            width: Type.Integer({ minimum: 1 }),
            height: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    effect: () => "read",
    resources: (input) => [`artifact:${input.artifactRef}`],
    async execute(input, context) {
      if (!options.getAllowedOriginalRefs(context.sessionId).has(input.artifactRef)) {
        throw new ToolFailure(
          "IMAGE_ATTACHMENT_DENIED",
          "read_image accepts only original image Artifacts attached to the current Session",
        );
      }
      const stored = await context.artifactStore.get(input.artifactRef);
      const digest = createHash("sha256").update(stored.content).digest("hex");
      if (input.artifactRef !== `artifact://${digest}`) {
        throw new ToolFailure("ARTIFACT_DIGEST_MISMATCH", "Original image Artifact failed digest verification");
      }
      const magicType = sniffImageMediaType(stored.content);
      const declaredType = normalizeImageMediaType(stored.mediaType);
      if (magicType === undefined || declaredType !== magicType) {
        throw new ToolFailure("IMAGE_MEDIA_TYPE_MISMATCH", "Original image media type does not match its bytes");
      }
      let metadata: sharp.Metadata;
      try {
        metadata = await sharp(stored.content, {
          failOn: "error",
          limitInputPixels: MAX_IMAGE_DECODE_PIXELS,
        }).metadata();
      } catch (error) {
        throw new ToolFailure(
          "IMAGE_DECODE_FAILED",
          `Original image could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const swapsAxes = (metadata.orientation ?? 1) >= 5 && (metadata.orientation ?? 1) <= 8;
      const originalWidth = swapsAxes ? metadata.height ?? 0 : metadata.width ?? 0;
      const originalHeight = swapsAxes ? metadata.width ?? 0 : metadata.height ?? 0;
      if (originalWidth <= 0 || originalHeight <= 0) {
        throw new ToolFailure("IMAGE_DIMENSIONS_INVALID", "Original image dimensions are unavailable");
      }
      const region = input.region ?? {
        x: 0,
        y: 0,
        width: originalWidth,
        height: originalHeight,
      };
      if (region.x + region.width > originalWidth || region.y + region.height > originalHeight) {
        throw new ToolFailure("IMAGE_REGION_OUT_OF_BOUNDS", "Requested image region exceeds original dimensions");
      }

      const encoded = await encodeReadImage(
        stored.content,
        region,
        metadata.hasAlpha === true,
        byteBudget,
        maxEdgePx,
      );
      const artifact = await context.artifactStore.put(encoded.data, encoded.mediaType);
      return {
        artifactRef: artifact.ref,
        mediaType: encoded.mediaType,
        byteLength: encoded.data.byteLength,
        width: encoded.width,
        height: encoded.height,
        originalWidth,
        originalHeight,
        resized: encoded.width !== region.width || encoded.height !== region.height,
        region,
      };
    },
    toModelOutput(output) {
      return [
        {
          type: "text",
          text: `Image region (${output.region.x},${output.region.y},${output.region.width}×${output.region.height}) prepared as ${output.width}×${output.height}.`,
        },
        {
          type: "artifact",
          ref: output.artifactRef,
          mediaType: output.mediaType,
          width: output.width,
          height: output.height,
        },
      ];
    },
  });
}

async function encodeReadImage(
  bytes: Uint8Array,
  region: { x: number; y: number; width: number; height: number },
  hasAlpha: boolean,
  byteBudget: number,
  maxEdgePx: number,
): Promise<{ data: Buffer; mediaType: "image/png" | "image/jpeg"; width: number; height: number }> {
  const longest = Math.max(region.width, region.height);
  const edges = [...new Set([
    Math.min(longest, maxEdgePx),
    1_500,
    1_000,
    768,
    512,
    384,
    256,
  ].filter((edge) => edge <= Math.min(longest, maxEdgePx)))];
  for (const edge of edges) {
    const base = () => sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_DECODE_PIXELS,
    })
      .rotate()
      .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
    if (hasAlpha) {
      const png = await base().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
      if (png.data.byteLength <= byteBudget) {
        return { data: png.data, mediaType: "image/png", width: png.info.width, height: png.info.height };
      }
      continue;
    }
    for (const quality of [80, 60, 40, 20] as const) {
      const jpeg = await base().jpeg({ quality, progressive: true, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      if (jpeg.data.byteLength <= byteBudget) {
        return { data: jpeg.data, mediaType: "image/jpeg", width: jpeg.info.width, height: jpeg.info.height };
      }
    }
  }
  throw new ToolFailure("IMAGE_READ_BUDGET", `Requested image view cannot fit within ${byteBudget} bytes`);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}
