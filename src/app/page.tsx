"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";
import { Rnd } from "react-rnd";

type Zone = {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  align: "left" | "center" | "right";
  color: string;
};

type CsvRow = Record<string, string>;

const DEFAULT_ZONE: Omit<Zone, "id" | "name"> = {
  x: 20,
  y: 20,
  w: 220,
  h: 80,
  fontSize: 28,
  align: "left",
  color: "#111111",
};

function newZone(index: number): Zone {
  return {
    id: crypto.randomUUID(),
    name: `Zone ${index + 1}`,
    ...DEFAULT_ZONE,
    x: DEFAULT_ZONE.x + index * 12,
    y: DEFAULT_ZONE.y + index * 12,
  };
}

export default function Page() {
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [templateUrl, setTemplateUrl] = useState<string | null>(null);

  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<CsvRow[]>([]);

  const [zones, setZones] = useState<Zone[]>([newZone(0)]);
  const [mapping, setMapping] = useState<Record<string, string>>({});

  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<"preview" | "generate" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readyForRender = useMemo(() => {
    if (!templateFile || !csvFile || zones.length === 0) return false;
    return zones.every((zone) => Boolean(mapping[zone.id]));
  }, [templateFile, csvFile, zones, mapping]);

  function resetAll() {
    if (templateUrl) URL.revokeObjectURL(templateUrl);
    if (previewImageUrl) URL.revokeObjectURL(previewImageUrl);

    setTemplateFile(null);
    setTemplateUrl(null);
    setCsvFile(null);
    setHeaders([]);
    setPreviewRows([]);
    setZones([newZone(0)]);
    setMapping({});
    setPreviewImageUrl(null);
    setLoading(null);
    setError(null);
  }

  function onTemplateChange(file: File | null) {
    setError(null);
    if (templateUrl) URL.revokeObjectURL(templateUrl);
    setTemplateFile(file);
    setTemplateUrl(file ? URL.createObjectURL(file) : null);
  }

  async function onCsvChange(file: File | null) {
    setError(null);
    setCsvFile(file);
    setHeaders([]);
    setPreviewRows([]);

    if (!file) return;

    const text = await file.text();
    const parsed = Papa.parse<CsvRow>(text, {
      header: true,
      skipEmptyLines: true,
    });

    if (parsed.errors.length > 0) {
      setError(parsed.errors[0]?.message ?? "Failed to parse CSV.");
      return;
    }

    const csvHeaders = (parsed.meta.fields ?? []).filter(Boolean);
    setHeaders(csvHeaders);
    setPreviewRows(parsed.data.slice(0, 5));

    setMapping((current) => {
      const next = { ...current };
      for (const zone of zones) {
        if (!next[zone.id] && csvHeaders.length > 0) {
          next[zone.id] = csvHeaders[0];
        }
      }
      return next;
    });
  }

  function addZone() {
    setZones((prev) => {
      const zone = newZone(prev.length);
      setMapping((current) => ({
        ...current,
        [zone.id]: headers[0] ?? "",
      }));
      return [...prev, zone];
    });
  }

  function removeZone(id: string) {
    setZones((prev) => prev.filter((zone) => zone.id !== id));
    setMapping((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  }

  function updateZone(id: string, patch: Partial<Zone>) {
    setZones((prev) => prev.map((zone) => (zone.id === id ? { ...zone, ...patch } : zone)));
  }

  async function callApi(path: "/api/preview" | "/api/generate") {
    if (!templateFile || !csvFile) {
      setError("Please upload both template PNG and CSV.");
      return;
    }

    const form = new FormData();
    form.append("template", templateFile);
    form.append("csv", csvFile);
    form.append("zones", JSON.stringify(zones));
    form.append("mapping", JSON.stringify(mapping));

    const response = await fetch(path, {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? `${path} failed`);
    }

    return response;
  }

  async function previewFirstRow() {
    setError(null);
    if (!readyForRender) {
      setError("Upload files and map all zones before previewing.");
      return;
    }

    setLoading("preview");
    try {
      const response = await callApi("/api/preview");
      if (!response) return;
      const blob = await response.blob();
      if (previewImageUrl) URL.revokeObjectURL(previewImageUrl);
      setPreviewImageUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setLoading(null);
    }
  }

  async function generateZip() {
    setError(null);
    if (!readyForRender) {
      setError("Upload files and map all zones before generating ZIP.");
      return;
    }

    setLoading("generate");
    try {
      const response = await callApi("/api/generate");
      if (!response) return;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "labelforge.zip";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generate failed.");
    } finally {
      setLoading(null);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">LabelForge</h1>

      {error && <p className="rounded border border-red-400 bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <section className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3 rounded border p-4">
          <h2 className="font-medium">Inputs</h2>
          <label className="block text-sm">
            Template PNG
            <input
              className="mt-1 block w-full text-sm"
              type="file"
              accept="image/png"
              onChange={(event) => onTemplateChange(event.target.files?.[0] ?? null)}
            />
          </label>

          <label className="block text-sm">
            CSV
            <input
              className="mt-1 block w-full text-sm"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                void onCsvChange(event.target.files?.[0] ?? null);
              }}
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button className="rounded border px-3 py-2 text-sm" onClick={addZone} type="button">
              Add Zone
            </button>
            <button
              className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-50"
              onClick={() => {
                void previewFirstRow();
              }}
              type="button"
              disabled={loading !== null}
            >
              {loading === "preview" ? "Previewing..." : "Preview Row 1"}
            </button>
            <button
              className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-50"
              onClick={() => {
                void generateZip();
              }}
              type="button"
              disabled={loading !== null}
            >
              {loading === "generate" ? "Generating..." : "Generate ZIP"}
            </button>
            <button className="rounded border px-3 py-2 text-sm" onClick={resetAll} type="button">
              Reset
            </button>
          </div>
        </div>

        <div className="space-y-3 rounded border p-4">
          <h2 className="font-medium">CSV Preview</h2>
          <p className="text-xs text-neutral-600">Headers: {headers.length > 0 ? headers.join(", ") : "(none)"}</p>
          <div className="overflow-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {headers.map((header) => (
                    <th key={header} className="border px-2 py-1 text-left font-medium">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, index) => (
                  <tr key={index}>
                    {headers.map((header) => (
                      <td key={`${index}-${header}`} className="border px-2 py-1">
                        {row[header]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded border p-4">
        <h2 className="font-medium">Template + Zones</h2>
        {!templateUrl ? (
          <p className="text-sm text-neutral-500">Upload a PNG template to place zones.</p>
        ) : (
          <div className="relative inline-block max-w-full border">
            <img src={templateUrl} alt="Template" className="block max-w-full" />
            <div className="pointer-events-none absolute inset-0">
              {zones.map((zone) => (
                <Rnd
                  key={zone.id}
                  bounds="parent"
                  size={{ width: zone.w, height: zone.h }}
                  position={{ x: zone.x, y: zone.y }}
                  onDragStop={(_, data) => updateZone(zone.id, { x: data.x, y: data.y })}
                  onResizeStop={(_, __, ref, ___, pos) => {
                    updateZone(zone.id, {
                      x: pos.x,
                      y: pos.y,
                      w: ref.offsetWidth,
                      h: ref.offsetHeight,
                    });
                  }}
                  style={{ border: "2px dashed #2563eb", background: "rgba(37,99,235,0.08)", pointerEvents: "auto" }}
                >
                  <div className="flex h-full w-full items-center justify-center text-xs font-medium text-blue-800">{zone.name}</div>
                </Rnd>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="space-y-2 rounded border p-4">
        <h2 className="font-medium">Zone Mapping</h2>
        <div className="space-y-2">
          {zones.map((zone, index) => (
            <div key={zone.id} className="grid gap-2 rounded border p-2 md:grid-cols-[1fr_auto_auto_auto_auto]">
              <input
                value={zone.name}
                onChange={(event) => updateZone(zone.id, { name: event.target.value })}
                className="rounded border px-2 py-1 text-sm"
              />
              <input
                type="number"
                value={zone.fontSize}
                onChange={(event) => updateZone(zone.id, { fontSize: Number(event.target.value) || 16 })}
                className="w-full rounded border px-2 py-1 text-sm"
                title="Font size"
              />
              <select
                value={zone.align}
                onChange={(event) => updateZone(zone.id, { align: event.target.value as Zone["align"] })}
                className="rounded border px-2 py-1 text-sm"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
              <select
                value={mapping[zone.id] ?? ""}
                onChange={(event) => setMapping((prev) => ({ ...prev, [zone.id]: event.target.value }))}
                className="rounded border px-2 py-1 text-sm"
              >
                <option value="">Select column</option>
                {headers.map((header) => (
                  <option key={header} value={header}>
                    {header}
                  </option>
                ))}
              </select>
              <button className="rounded border px-2 py-1 text-sm" onClick={() => removeZone(zone.id)} type="button">
                Remove
              </button>
              <input
                type="color"
                value={zone.color}
                onChange={(event) => updateZone(zone.id, { color: event.target.value })}
                className="h-9 w-12 rounded border"
                title="Text color"
              />
              <div className="text-xs text-neutral-500 md:col-span-5">Zone {index + 1}</div>
            </div>
          ))}
        </div>
      </section>

      {previewImageUrl && (
        <section className="space-y-2 rounded border p-4">
          <h2 className="font-medium">Preview Output</h2>
          <img src={previewImageUrl} alt="Preview row 1" className="max-w-full border" />
        </section>
      )}
    </main>
  );
}
