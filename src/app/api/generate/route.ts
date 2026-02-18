import { NextResponse } from "next/server";
import Papa from "papaparse";
import sharp from "sharp";
import archiver from "archiver";
import { PassThrough } from "stream";

export const runtime = "nodejs";

type Zone = {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  align: "left" | "center" | "right";
  color: string; // hex like #000000
  bgEnabled?: boolean;
  bgColor?: string; // rgba string like "rgba(255,255,255,0.85)"
  padding?: number; // px
};

type Mapping = Record<string, string>; // zoneId -> csvColumnName

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Minimal, reliable wrapping: use <foreignObject> with HTML/CSS.
// This makes text wrap naturally inside the zone.
function wrapText(text: string, maxCharsPerLine: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (test.length <= maxCharsPerLine) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function makeOverlaySvg(
  width: number,
  height: number,
  zones: Zone[],
  mapping: Mapping,
  row: Record<string, any>
) {
  const blocks = zones
    .map((z) => {
      const col = mapping[z.id];
      const raw = col ? row[col] : "";
      const textRaw = String(raw ?? "").trim();

      const fontSize = Math.max(8, Math.min(120, Number(z.fontSize || 24)));
      const lineHeight = Math.round(fontSize * 1.2);

      // Rough estimate of characters per line based on font size
      const maxCharsPerLine = Math.max(5, Math.floor((z.w - (z.padding ?? 8) * 2) / (fontSize * 0.6)));

      const pad = Number.isFinite(z.padding) ? (z.padding as number) : 8;

      const lines = wrapText(textRaw, maxCharsPerLine);

      // Clamp lines to fit height
      const maxLines = Math.max(1, Math.floor((z.h - pad * 2) / lineHeight));
      const clipped = lines.slice(0, maxLines);

      // If clipped, add ellipsis to last line
      if (lines.length > maxLines && clipped.length) {
        const last = clipped[clipped.length - 1];
        clipped[clipped.length - 1] = last.length > 3 ? last.slice(0, Math.max(0, last.length - 3)) + "..." : "...";
      }

      const align =
        z.align === "right" ? "end" : z.align === "center" ? "middle" : "start";

      const x =
        z.align === "right"
          ? z.x + z.w - pad
          : z.align === "center"
          ? z.x + z.w / 2
          : z.x + pad;

      const yStart = z.y + pad + fontSize; // baseline

      const color = z.color || "#000000";

      const bgEnabled = !!z.bgEnabled;
      const bgColor = z.bgColor ?? "rgba(255,255,255,0.85)";
      const rect = bgEnabled
        ? `<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="12" ry="12" fill="${bgColor}"/>`
        : "";

      const tspans = clipped
        .map((ln, i) => {
          const safe = escapeHtml(ln);
          const dy = i === 0 ? 0 : lineHeight;
          return `<tspan x="${x}" dy="${dy}">${safe}</tspan>`;
        })
        .join("");

      return `
        ${rect}
        <text x="${x}" y="${yStart}"
              fill="${color}"
              font-family="Inter, Arial, sans-serif"
              font-size="${fontSize}"
              text-anchor="${align}">
          ${tspans}
        </text>
      `;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
${blocks}
</svg>`;
}


async function streamToBuffer(stream: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();

    const templateFile = form.get("template") as File | null;
    const csvFile = form.get("csv") as File | null;
    const zonesJson = form.get("zones") as string | null;
    const mappingJson = form.get("mapping") as string | null;

    if (!templateFile || !csvFile || !zonesJson || !mappingJson) {
      return NextResponse.json(
        { error: "Missing template/csv/zones/mapping" },
        { status: 400 }
      );
    }

    const zones: Zone[] = JSON.parse(zonesJson);
    const mapping: Mapping = JSON.parse(mappingJson);

    const templateBuf = Buffer.from(await templateFile.arrayBuffer());
    const csvText = Buffer.from(await csvFile.arrayBuffer()).toString("utf-8");

    // Parse CSV
    const parsed = Papa.parse<Record<string, any>>(csvText, {
      header: true,
      skipEmptyLines: true,
    });

    if (parsed.errors?.length) {
      return NextResponse.json(
        { error: "CSV parse error", details: parsed.errors },
        { status: 400 }
      );
    }

    const rows = (parsed.data || []).filter((r) => Object.keys(r || {}).length > 0);

    // MVP limits (protect server + cost)
    const MAX_ROWS = 200;
    if (rows.length > MAX_ROWS) {
      return NextResponse.json(
        { error: `Too many rows. MVP limit is ${MAX_ROWS}.` },
        { status: 400 }
      );
    }

    // Read template metadata for correct output dimensions
    const meta = await sharp(templateBuf).metadata();
    if (!meta.width || !meta.height) {
      return NextResponse.json(
        { error: "Could not read template image dimensions." },
        { status: 400 }
      );
    }

    const width = meta.width;
    const height = meta.height;

    // ZIP stream in memory
    const zipStream = new PassThrough();
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("warning", (err) => {
      // non-fatal warnings
      console.warn("archiver warning", err);
    });

    archive.on("error", (err) => {
      throw err;
    });

    archive.pipe(zipStream);

    // Generate images
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as Record<string, any>;
      const svg = makeOverlaySvg(width, height, zones, mapping, row);

      const outPng = await sharp(templateBuf)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .png()
        .toBuffer();

      const fname = String(i + 1).padStart(4, "0") + ".png";
      archive.append(outPng, { name: `images/${fname}` });
    }

    // Also include output.csv (enhanced) for convenience
    const outputCsv = Papa.unparse(rows);
    archive.append(outputCsv, { name: "output.csv" });

    await archive.finalize();

    const zipBuf = await streamToBuffer(zipStream);

    return new NextResponse(zipBuf, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="labelforge.zip"',
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json(
      { error: "Server error", details: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}
