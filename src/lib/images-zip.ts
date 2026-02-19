import yauzl from "yauzl";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) return "";
  return fileName.slice(dotIndex).toLowerCase();
}

export function normalizeImageFileName(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed) return "";
  const parts = trimmed.split("/").filter(Boolean);
  return (parts.at(-1) ?? "").toLowerCase();
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export async function parseImagesZip(zipBuffer: Buffer): Promise<Map<string, Buffer>> {
  const images = new Map<string, Buffer>();

  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (zipErr, zipFile) => {
      if (zipErr || !zipFile) {
        reject(zipErr ?? new Error("Failed to read ZIP file."));
        return;
      }

      zipFile.readEntry();
      zipFile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipFile.readEntry();
          return;
        }

        const normalizedName = normalizeImageFileName(entry.fileName);
        if (!normalizedName || !IMAGE_EXTENSIONS.has(getExtension(normalizedName))) {
          zipFile.readEntry();
          return;
        }

        zipFile.openReadStream(entry, async (streamErr, stream) => {
          if (streamErr || !stream) {
            reject(streamErr ?? new Error(`Failed to read ZIP entry "${entry.fileName}".`));
            return;
          }

          try {
            images.set(normalizedName, await streamToBuffer(stream));
            zipFile.readEntry();
          } catch (readErr) {
            reject(readErr);
          }
        });
      });

      zipFile.on("end", resolve);
      zipFile.on("error", reject);
    });
  });

  if (images.size === 0) {
    throw new Error("Images ZIP did not contain any .png/.jpg/.jpeg files.");
  }

  return images;
}
