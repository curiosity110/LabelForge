import { NextResponse } from "next/server";
import Papa from "papaparse";
import sharp from "sharp";
import { normalizeImageFileName, parseImagesZip } from "@/lib/images-zip";

export const runtime = "nodejs";

const MAX_ROWS = 50;
const MAX_TEMPLATE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_CSV_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES_ZIP_SIZE_BYTES = 50 * 1024 * 1024;

type Zone = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize?: number;
  align?: "left" | "center" | "right";
  color?: string;
};

type Mapping = Record<string, string>;
type SourceMode = "template" | "zip";
type ZipAssignMode = "filename" | "rowOrder";


function parseJson<T>(value: string, name: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Invalid ${name} payload.`);
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapAndClamp(text: string, zone: Zone, fontSize: number): string[] {
  const padding = 6;
  const usableWidth = Math.max(1, zone.w - padding * 2);
  const approxCharsPerLine = Math.max(1, Math.floor(usableWidth / (fontSize * 0.58)));

  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= approxCharsPerLine) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = "";
    }

    if (word.length > approxCharsPerLine) {
      let start = 0;
      while (start < word.length) {
        lines.push(word.slice(start, start + approxCharsPerLine));
        start += approxCharsPerLine;
      }
    } else {
      current = word;
    }
  }

  if (current) lines.push(current);
  if (lines.length === 0) lines.push("");

  const lineHeight = Math.round(fontSize * 1.2);
  const maxLines = Math.max(1, Math.floor((zone.h - padding * 2) / lineHeight));
  const clipped = lines.slice(0, maxLines);

  if (lines.length > maxLines) {
    const lastIndex = clipped.length - 1;
    clipped[lastIndex] = `${clipped[lastIndex].slice(0, Math.max(0, clipped[lastIndex].length - 1))}…`;
  }

  return clipped;
}

function buildOverlaySvg(width: number, height: number, zones: Zone[], mapping: Mapping, row: Record<string, string>): string {
  const blocks = zones
    .map((zone) => {
      const column = mapping[zone.id];
      const value = column ? String(row[column] ?? "") : "";
      const fontSize = Math.max(8, Math.min(120, Number(zone.fontSize ?? 24)));
      const lines = wrapAndClamp(value, zone, fontSize);
      const padding = 6;
      const lineHeight = Math.round(fontSize * 1.2);
      const align = zone.align === "right" ? "end" : zone.align === "center" ? "middle" : "start";
      const anchorX =
        zone.align === "right"
          ? zone.x + zone.w - padding
          : zone.align === "center"
            ? zone.x + zone.w / 2
            : zone.x + padding;
      const startY = zone.y + padding + fontSize;

      const tspans = lines
        .map((line, index) => {
          const dy = index === 0 ? 0 : lineHeight;
          return `<tspan x="${anchorX}" dy="${dy}">${escapeXml(line)}</tspan>`;
        })
        .join("");

      return `<text x="${anchorX}" y="${startY}" font-size="${fontSize}" fill="${zone.color ?? "#111111"}" text-anchor="${align}" font-family="Arial, sans-serif">${tspans}</text>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${blocks}</svg>`;
}

export async function POST(request: Request) {
  const form = await request.formData();

  const template = form.get("template");
  const csv = form.get("csv");
  const imagesZip = form.get("imagesZip");
  const sourceModeRaw = form.get("sourceMode");
  const zipAssignModeRaw = form.get("zipAssignMode");
  const imageColumnRaw = form.get("imageColumn");
  const zonesRaw = form.get("zones");
  const mappingRaw = form.get("mapping");

  if (!(csv instanceof File) || typeof zonesRaw !== "string" || typeof mappingRaw !== "string") {
    return NextResponse.json({ error: "Missing csv, zones, or mapping." }, { status: 400 });
  }

  const sourceMode: SourceMode = sourceModeRaw === "zip" ? "zip" : "template";
  const zipAssignMode: ZipAssignMode = zipAssignModeRaw === "rowOrder" ? "rowOrder" : "filename";

  if (template instanceof File && template.size > MAX_TEMPLATE_SIZE_BYTES) {
    return NextResponse.json({ error: "Template exceeds 5MB limit." }, { status: 400 });
  }

  if (imagesZip instanceof File && imagesZip.size > MAX_IMAGES_ZIP_SIZE_BYTES) {
    return NextResponse.json({ error: "Images ZIP exceeds 50MB limit." }, { status: 400 });
  }

  if (csv.size > MAX_CSV_SIZE_BYTES) {
    return NextResponse.json({ error: "CSV exceeds 2MB limit." }, { status: 400 });
  }

  let zones: Zone[];
  let mapping: Mapping;
  try {
    zones = parseJson<Zone[]>(zonesRaw, "zones");
    mapping = parseJson<Mapping>(mappingRaw, "mapping");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request payload." }, { status: 400 });
  }
  const imageColumn = typeof imageColumnRaw === "string" && imageColumnRaw ? imageColumnRaw : "image_file";

  if (!Array.isArray(zones) || zones.length === 0) {
    return NextResponse.json({ error: "At least one zone is required." }, { status: 400 });
  }

  const csvText = Buffer.from(await csv.arrayBuffer()).toString("utf8");
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    return NextResponse.json({ error: parsed.errors[0]?.message ?? "CSV parse failed." }, { status: 400 });
  }

  const headers = (parsed.meta.fields ?? []).filter(Boolean);
  if (sourceMode === "zip" && zipAssignMode === "filename" && !headers.includes(imageColumn)) {
    return NextResponse.json({ error: `Image filename column "${imageColumn}" does not exist in CSV.` }, { status: 400 });
  }

  const rows = parsed.data.filter((row: Record<string, string>) => Object.keys(row).length > 0);
  if (rows.length === 0) {
    return NextResponse.json({ error: "CSV has no rows." }, { status: 400 });
  }

  if (rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `CSV exceeds MAX_ROWS (${MAX_ROWS}).` }, { status: 400 });
  }

  const firstRow = rows[0];
  let backgroundBuffer: Buffer;

  if (sourceMode === "template") {
    if (!(template instanceof File)) {
      return NextResponse.json({ error: "Template PNG is required in Template PNG mode." }, { status: 400 });
    }
    backgroundBuffer = Buffer.from(await template.arrayBuffer());
  } else {
    if (!(imagesZip instanceof File)) {
      return NextResponse.json({ error: "Images ZIP is required in Images ZIP mode." }, { status: 400 });
    }

    let imageMap: Map<string, Buffer>;
    try {
      imageMap = await parseImagesZip(Buffer.from(await imagesZip.arrayBuffer()));
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to read images ZIP." },
        { status: 400 },
      );
    }

    if (zipAssignMode === "rowOrder") {
      const sortedNames = [...imageMap.keys()].sort((a, b) => a.localeCompare(b));
      const firstName = sortedNames[0];
      const firstImage = firstName ? imageMap.get(firstName) : null;
      if (!firstImage) {
        return NextResponse.json({ error: "Images ZIP did not contain any usable image files." }, { status: 400 });
      }
      backgroundBuffer = firstImage;
    } else {
      const imageFileName = String(firstRow[imageColumn] ?? "").trim();
      if (!imageFileName) {
        return NextResponse.json({ error: `Row 1 is missing image filename in column "${imageColumn}".` }, { status: 400 });
      }

      const normalizedName = normalizeImageFileName(imageFileName);
      const imageFromZip = imageMap.get(normalizedName);
      if (!imageFromZip) {
        return NextResponse.json({ error: `Missing image "${imageFileName}" in uploaded ZIP.` }, { status: 400 });
      }
      backgroundBuffer = imageFromZip;
    }
  }

  const metadata = await sharp(backgroundBuffer).metadata();
  if (!metadata.width || !metadata.height) {
    return NextResponse.json({ error: "Image dimensions could not be read." }, { status: 400 });
  }

  const svg = buildOverlaySvg(metadata.width, metadata.height, zones, mapping, firstRow);
  const output = await sharp(backgroundBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();

  return new NextResponse(new Uint8Array(output), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    },
  });
}
