import { inflateRawSync } from "node:zlib";
import { NextResponse } from "next/server";
import Papa from "papaparse";
import sharp from "sharp";

export const runtime = "nodejs";

const MAX_ROWS = 50;
const MAX_TEMPLATE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_CSV_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES_ZIP_SIZE_BYTES = 50 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

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

type ZipEntry = {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
};

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

function getBaseName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

function readUint32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function readUint16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function parseZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdSignature = 0x06054b50;
  const cdSignature = 0x02014b50;
  let eocdOffset = -1;

  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i -= 1) {
    if (readUint32(buffer, i) === eocdSignature) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error("Invalid ZIP: end of central directory not found.");
  }

  const centralDirectorySize = readUint32(buffer, eocdOffset + 12);
  const centralDirectoryOffset = readUint32(buffer, eocdOffset + 16);
  const entries: ZipEntry[] = [];

  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;

  while (offset < end) {
    if (readUint32(buffer, offset) !== cdSignature) {
      throw new Error("Invalid ZIP: malformed central directory entry.");
    }

    const compressionMethod = readUint16(buffer, offset + 10);
    const compressedSize = readUint32(buffer, offset + 20);
    const uncompressedSize = readUint32(buffer, offset + 24);
    const fileNameLength = readUint16(buffer, offset + 28);
    const extraLength = readUint16(buffer, offset + 30);
    const commentLength = readUint16(buffer, offset + 32);
    const localHeaderOffset = readUint32(buffer, offset + 42);
    const fileName = buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength);

    entries.push({
      fileName,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
    });

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function extractEntryBuffer(zipBuffer: Buffer, entry: ZipEntry): Buffer {
  const localSignature = 0x04034b50;
  if (readUint32(zipBuffer, entry.localHeaderOffset) !== localSignature) {
    throw new Error(`Invalid ZIP: missing local header for ${entry.fileName}.`);
  }

  const fileNameLength = readUint16(zipBuffer, entry.localHeaderOffset + 26);
  const extraLength = readUint16(zipBuffer, entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressedData = zipBuffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return Buffer.from(compressedData);
  }
  if (entry.compressionMethod === 8) {
    return inflateRawSync(compressedData);
  }

  throw new Error(`Unsupported ZIP compression method for ${entry.fileName}.`);
}

function parseImagesZip(zipBuffer: Buffer): Map<string, Buffer> {
  const images = new Map<string, Buffer>();
  const entries = parseZipEntries(zipBuffer);

  for (const entry of entries) {
    if (entry.fileName.endsWith("/")) continue;
    const baseName = getBaseName(entry.fileName);
    const ext = baseName.slice(baseName.lastIndexOf(".")).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const fileBuffer = extractEntryBuffer(zipBuffer, entry);
    images.set(baseName, fileBuffer);
  }

  if (images.size === 0) {
    throw new Error("Images ZIP did not contain any .png/.jpg/.jpeg files.");
  }

  return images;
}

export async function POST(request: Request) {
  const form = await request.formData();

  const template = form.get("template");
  const csv = form.get("csv");
  const imagesZip = form.get("imagesZip");
  const imageColumnRaw = form.get("imageColumn");
  const zonesRaw = form.get("zones");
  const mappingRaw = form.get("mapping");

  if (!(csv instanceof File) || typeof zonesRaw !== "string" || typeof mappingRaw !== "string") {
    return NextResponse.json({ error: "Missing csv, zones, or mapping." }, { status: 400 });
  }

  if (!(template instanceof File) && !(imagesZip instanceof File)) {
    return NextResponse.json({ error: "Upload template PNG or images ZIP." }, { status: 400 });
  }

  if (template instanceof File && template.size > MAX_TEMPLATE_SIZE_BYTES) {
    return NextResponse.json({ error: "Template exceeds 5MB limit." }, { status: 400 });
  }

  if (imagesZip instanceof File && imagesZip.size > MAX_IMAGES_ZIP_SIZE_BYTES) {
    return NextResponse.json({ error: "Images ZIP exceeds 50MB limit." }, { status: 400 });
  }

  if (csv.size > MAX_CSV_SIZE_BYTES) {
    return NextResponse.json({ error: "CSV exceeds 2MB limit." }, { status: 400 });
  }

  const zones = JSON.parse(zonesRaw) as Zone[];
  const mapping = JSON.parse(mappingRaw) as Mapping;
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
  if (!headers.includes("image_file")) {
    return NextResponse.json({ error: 'CSV must include a column named "image_file".' }, { status: 400 });
  }
  if (!headers.includes(imageColumn)) {
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

  if (imagesZip instanceof File) {
    const imageMap = parseImagesZip(Buffer.from(await imagesZip.arrayBuffer()));
    const imageFileName = String(firstRow[imageColumn] ?? "").trim();
    if (!imageFileName) {
      return NextResponse.json({ error: `Row 1 is missing image filename in column "${imageColumn}".` }, { status: 400 });
    }

    const imageFromZip = imageMap.get(getBaseName(imageFileName));
    if (!imageFromZip) {
      return NextResponse.json({ error: `Missing image "${imageFileName}" in uploaded ZIP.` }, { status: 400 });
    }
    backgroundBuffer = imageFromZip;
  } else if (template instanceof File) {
    backgroundBuffer = Buffer.from(await template.arrayBuffer());
  } else {
    return NextResponse.json({ error: "Upload template PNG or images ZIP." }, { status: 400 });
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
