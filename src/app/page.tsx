"use client";

import { useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { Rnd } from "react-rnd";

type SourceMode = "template" | "zip";
type ZipAssignMode = "filename" | "rowOrder";

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
  editorBgEnabled: boolean;
  editorBgColor: string;
  editorBgOpacity: number;
};

type CsvRow = Record<string, string>;

const DEFAULT_ZONE: Omit<Zone, "id" | "name"> = {
  x: 20,
  y: 20,
  w: 220,
  h: 80,
  fontSize: 28,
  align: "left",
  color: "#2563eb",
  editorBgEnabled: true,
  editorBgColor: "#ffffff",
  editorBgOpacity: 0.85,
};

const ZONE_COLORS = ["#2563eb", "#16a34a", "#ea580c", "#7c3aed", "#dc2626"];
const GRID_SIZE = 10;
const MAX_ZONES = 10;
const AUTO_CREATE_COUNT = 6;

function newZone(index: number): Zone {
  return {
    id: crypto.randomUUID(),
    name: `Zone ${index + 1}`,
    ...DEFAULT_ZONE,
    color: ZONE_COLORS[index % ZONE_COLORS.length],
    x: DEFAULT_ZONE.x + index * 12,
    y: DEFAULT_ZONE.y + index * 12,
  };
}

function snap(value: number, enabled: boolean) {
  if (!enabled) return value;
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function toRgba(hex: string, opacity: number): string {
  const normalized = hex.replace("#", "");
  const chunk = normalized.length === 3 ? normalized.split("").map((c) => `${c}${c}`).join("") : normalized;
  if (chunk.length !== 6) return `rgba(255,255,255,${opacity})`;
  const r = Number.parseInt(chunk.slice(0, 2), 16);
  const g = Number.parseInt(chunk.slice(2, 4), 16);
  const b = Number.parseInt(chunk.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, opacity))})`;
}

export default function Page() {
  const [sourceMode, setSourceMode] = useState<SourceMode>("template");
  const [zipAssignMode, setZipAssignMode] = useState<ZipAssignMode>("filename");

  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [templateUrl, setTemplateUrl] = useState<string | null>(null);
  const [imagesZipFile, setImagesZipFile] = useState<File | null>(null);

  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<CsvRow[]>([]);
  const [imageColumn, setImageColumn] = useState("image_file");
  const [showRow1Values, setShowRow1Values] = useState(false);

  const [zones, setZones] = useState<Zone[]>([newZone(0)]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<"preview" | "generate" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readyForRender = useMemo(() => {
    const hasSource = sourceMode === "template" ? Boolean(templateFile) : Boolean(imagesZipFile);
    if (!hasSource || !csvFile || zones.length === 0) return false;
    if (sourceMode === "zip" && zipAssignMode === "filename" && !imageColumn) return false;
    return zones.every((zone) => Boolean(mapping[zone.id]));
  }, [csvFile, imageColumn, imagesZipFile, mapping, sourceMode, templateFile, zipAssignMode, zones]);

  const rowOne = previewRows[0];

  function zoneText(zone: Zone): string {
    const mappedColumn = mapping[zone.id];
    if (showRow1Values && rowOne && mappedColumn) {
      const rowValue = String(rowOne[mappedColumn] ?? "").trim();
      if (rowValue) return rowValue;
    }
    return `{{${zone.name || mappedColumn || "zone"}}}`;
  }

  function resetAll() {
    if (templateUrl) URL.revokeObjectURL(templateUrl);
    if (previewImageUrl) URL.revokeObjectURL(previewImageUrl);

    setSourceMode("template");
    setZipAssignMode("filename");
    setTemplateFile(null);
    setTemplateUrl(null);
    setCsvFile(null);
    setImagesZipFile(null);
    setHeaders([]);
    setPreviewRows([]);
    setImageColumn("image_file");
    setShowRow1Values(false);
    setZones([newZone(0)]);
    setMapping({});
    setSelectedZoneId(null);
    setSnapToGrid(true);
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

  function onImagesZipChange(file: File | null) {
    setError(null);
    setImagesZipFile(file);
  }

  async function onCsvChange(file: File | null) {
    setError(null);
    setCsvFile(file);
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
    setShowRow1Values(parsed.data.length > 0);

    setImageColumn((current) => {
      if (csvHeaders.includes(current)) return current;
      if (csvHeaders.includes("image_file")) return "image_file";
      return csvHeaders[0] ?? "";
    });

    setMapping((current) => {
      const next = { ...current };
      for (let index = 0; index < zones.length; index += 1) {
        const zone = zones[index];
        if (!next[zone.id] && csvHeaders[index]) {
          next[zone.id] = csvHeaders[index];
        }
      }
      return next;
    });
  }

  function addZone() {
    setZones((prev) => {
      if (prev.length >= MAX_ZONES) return prev;
      const zoneIndex = prev.length;
      const zone = newZone(zoneIndex);
      const mappedHeader = headers[zoneIndex];
      zone.name = mappedHeader ?? `Zone ${zoneIndex + 1}`;
      setMapping((current) => ({
        ...current,
        [zone.id]: mappedHeader ?? "",
      }));
      setSelectedZoneId(zone.id);
      return [...prev, zone];
    });
  }

  function autoCreateZonesFromHeaders() {
    if (headers.length === 0) return;
    const count = Math.min(headers.length, AUTO_CREATE_COUNT, MAX_ZONES);
    const nextZones = headers.slice(0, count).map((header, index) => {
      const zone = newZone(index);
      zone.name = header;
      return zone;
    });
    const nextMapping = Object.fromEntries(nextZones.map((zone, index) => [zone.id, headers[index] ?? ""]));
    setZones(nextZones);
    setMapping(nextMapping);
    setSelectedZoneId(nextZones[0]?.id ?? null);
  }

  function removeZone(id: string) {
    setZones((prev) => prev.filter((zone) => zone.id !== id));
    setMapping((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
    setSelectedZoneId((current) => (current === id ? null : current));
  }

  function updateZone(id: string, patch: Partial<Zone>) {
    setZones((prev) => prev.map((zone) => (zone.id === id ? { ...zone, ...patch } : zone)));
  }

  function getOverlayBounds() {
    const node = overlayRef.current;
    return {
      width: node?.offsetWidth ?? 0,
      height: node?.offsetHeight ?? 0,
    };
  }

  function updateManyZones(ids: string[], updater: (zone: Zone) => Partial<Zone>) {
    if (ids.length === 0) return;
    setZones((prev) => prev.map((zone) => (ids.includes(zone.id) ? { ...zone, ...updater(zone) } : zone)));
  }

  function alignZones(mode: "left" | "centerX" | "right" | "top" | "centerY" | "bottom") {
    const ids = selectedZoneId ? [selectedZoneId] : zones.map((zone) => zone.id);
    const { width, height } = getOverlayBounds();
    updateManyZones(ids, (zone) => {
      if (mode === "left") return { x: 0 };
      if (mode === "centerX") return { x: Math.max(0, (width - zone.w) / 2) };
      if (mode === "right") return { x: Math.max(0, width - zone.w) };
      if (mode === "top") return { y: 0 };
      if (mode === "centerY") return { y: Math.max(0, (height - zone.h) / 2) };
      return { y: Math.max(0, height - zone.h) };
    });
  }

  function stackZones(direction: "vertical" | "horizontal") {
    if (zones.length === 0) return;
    const sorted = [...zones].sort((a, b) => (direction === "vertical" ? a.y - b.y : a.x - b.x));
    let cursor = 0;
    const updates: Record<string, Partial<Zone>> = {};
    for (const zone of sorted) {
      updates[zone.id] = direction === "vertical" ? { x: 0, y: cursor } : { y: 0, x: cursor };
      cursor += (direction === "vertical" ? zone.h : zone.w) + 12;
    }
    setZones((prev) => prev.map((zone) => (updates[zone.id] ? { ...zone, ...updates[zone.id] } : zone)));
  }

  function distribute(direction: "vertical" | "horizontal") {
    if (zones.length < 3) return;
    const sorted = [...zones].sort((a, b) => (direction === "vertical" ? a.y - b.y : a.x - b.x));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const start = direction === "vertical" ? first.y : first.x;
    const endEdge = direction === "vertical" ? last.y + last.h : last.x + last.w;
    const totalSize = sorted.reduce((sum, zone) => sum + (direction === "vertical" ? zone.h : zone.w), 0);
    const gap = (endEdge - start - totalSize) / (sorted.length - 1);
    let cursor = start;
    const updates: Record<string, Partial<Zone>> = {};
    for (const zone of sorted) {
      updates[zone.id] = direction === "vertical" ? { y: cursor } : { x: cursor };
      cursor += (direction === "vertical" ? zone.h : zone.w) + gap;
    }
    setZones((prev) => prev.map((zone) => (updates[zone.id] ? { ...zone, ...updates[zone.id] } : zone)));
  }

  async function callApi(path: "/api/preview" | "/api/generate") {
    if (!csvFile) {
      setError("Please upload CSV.");
      return;
    }
    if (sourceMode === "template" && !templateFile) {
      setError("Template mode requires a template PNG.");
      return;
    }
    if (sourceMode === "zip" && !imagesZipFile) {
      setError("Images ZIP mode requires an images ZIP upload.");
      return;
    }
    if (sourceMode === "zip" && zipAssignMode === "filename" && !imageColumn) {
      setError("Choose a CSV column for ZIP filename matching.");
      return;
    }

    const form = new FormData();
    if (sourceMode === "template" && templateFile) {
      form.append("template", templateFile);
    }
    if (sourceMode === "zip" && imagesZipFile) {
      form.append("imagesZip", imagesZipFile);
    }
    form.append("csv", csvFile);
    form.append("sourceMode", sourceMode);
    form.append("zipAssignMode", zipAssignMode);
    if (sourceMode === "zip" && zipAssignMode === "filename" && imageColumn) {
      form.append("imageColumn", imageColumn);
    }
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
      setError("Upload required source files and map all zones before previewing.");
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
      setError("Upload required source files and map all zones before generating ZIP.");
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

          <fieldset className="rounded border p-2 text-sm">
            <legend className="px-1 text-xs font-medium">Source Mode</legend>
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="sourceMode"
                  checked={sourceMode === "template"}
                  onChange={() => {
                    setSourceMode("template");
                    setError(null);
                  }}
                />
                Template PNG
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="sourceMode"
                  checked={sourceMode === "zip"}
                  onChange={() => {
                    setSourceMode("zip");
                    setError(null);
                  }}
                />
                Images ZIP
              </label>
            </div>
          </fieldset>

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

          <label className="block text-sm">
            Images ZIP
            <input
              className="mt-1 block w-full text-sm"
              type="file"
              accept=".zip,application/zip"
              onChange={(event) => onImagesZipChange(event.target.files?.[0] ?? null)}
            />
          </label>

          {sourceMode === "zip" && (
            <>
              <label className="block text-sm">
                ZIP assignment mode
                <select
                  value={zipAssignMode}
                  onChange={(event) => {
                    setZipAssignMode(event.target.value as ZipAssignMode);
                    setError(null);
                  }}
                  className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                >
                  <option value="filename">Match by filename (CSV column)</option>
                  <option value="rowOrder">Match by row order</option>
                </select>
              </label>

              {zipAssignMode === "filename" && (
                <label className="block text-sm">
                  Image filename column
                  <select
                    value={imageColumn}
                    onChange={(event) => {
                      setError(null);
                      setImageColumn(event.target.value);
                    }}
                    className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                  >
                    {headers.length === 0 && <option value="">No CSV headers loaded</option>}
                    {headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}

          <div className="flex flex-wrap gap-2">
            <button className="rounded border px-3 py-2 text-sm" onClick={addZone} type="button">
              Add Zone
            </button>
            <button
              className="rounded border px-3 py-2 text-sm disabled:opacity-50"
              onClick={autoCreateZonesFromHeaders}
              type="button"
              disabled={headers.length === 0}
            >
              Auto-create zones from CSV headers
            </button>
            <label className="flex items-center gap-2 rounded border px-3 py-2 text-sm">
              <input type="checkbox" checked={snapToGrid} onChange={(event) => setSnapToGrid(event.target.checked)} />
              Snap to grid (10px)
            </label>
            <label className="flex items-center gap-2 rounded border px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={showRow1Values}
                onChange={(event) => setShowRow1Values(event.target.checked)}
                disabled={previewRows.length === 0}
              />
              Show Row 1 values in zones
            </label>
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
        <div className="flex flex-wrap gap-2">
          <button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => stackZones("vertical")}>Stack Vertical</button>
          <button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => stackZones("horizontal")}>Stack Horizontal</button>
          <button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => alignZones("left")}>Align Left</button>
          <button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => alignZones("centerX")}>Align Center X</button>
          <button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => alignZones("right")}>Align Right</button>
          <button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => alignZones("top")}>Align Top</button>
          <button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => alignZones("centerY")}>Align Center Y</button>
          <button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => alignZones("bottom")}>Align Bottom</button>
          <button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => distribute("vertical")}>Distribute Vertical</button>
          <button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => distribute("horizontal")}>Distribute Horizontal</button>
        </div>
        {!templateUrl ? (
          <p className="text-sm text-neutral-500">Upload a PNG template to place zones visually in the editor.</p>
        ) : (
          <div className="relative inline-block max-w-full border">
            <img src={templateUrl} alt="Template" className="block max-w-full" />
            <div ref={overlayRef} className="pointer-events-none absolute inset-0">
              {zones.map((zone) => (
                <Rnd
                  key={zone.id}
                  bounds="parent"
                  size={{ width: zone.w, height: zone.h }}
                  position={{ x: zone.x, y: zone.y }}
                  dragGrid={snapToGrid ? [GRID_SIZE, GRID_SIZE] : undefined}
                  resizeGrid={snapToGrid ? [GRID_SIZE, GRID_SIZE] : undefined}
                  onDragStart={() => setSelectedZoneId(zone.id)}
                  onDragStop={(_, data) =>
                    updateZone(zone.id, {
                      x: snap(data.x, snapToGrid),
                      y: snap(data.y, snapToGrid),
                    })
                  }
                  onResizeStop={(_, __, ref, ___, pos) => {
                    setSelectedZoneId(zone.id);
                    updateZone(zone.id, {
                      x: snap(pos.x, snapToGrid),
                      y: snap(pos.y, snapToGrid),
                      w: snap(ref.offsetWidth, snapToGrid),
                      h: snap(ref.offsetHeight, snapToGrid),
                    });
                  }}
                  onClick={() => setSelectedZoneId(zone.id)}
                  style={{
                    border: selectedZoneId === zone.id ? `3px solid ${zone.color}` : `2px solid ${zone.color}`,
                    background: "rgba(255,255,255,0.12)",
                    boxShadow: selectedZoneId === zone.id ? "0 0 0 2px rgba(255,255,255,0.7), 0 4px 12px rgba(0,0,0,0.2)" : "none",
                    pointerEvents: "auto",
                  }}
                >
                  <div className="relative flex h-full w-full flex-col overflow-hidden p-2">
                    <div
                      className="w-fit rounded px-2 py-0.5 text-[10px] font-semibold text-white"
                      style={{ backgroundColor: zone.color }}
                    >
                      {zone.name}
                    </div>
                    <div
                      className="mt-1 rounded px-2 py-1 text-xs font-medium leading-snug text-neutral-800"
                      style={{
                        background: zone.editorBgEnabled ? toRgba(zone.editorBgColor, zone.editorBgOpacity) : "transparent",
                        display: "-webkit-box",
                        WebkitLineClamp: Math.max(2, Math.min(4, Math.floor(zone.h / 28) || 2)),
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {zoneText(zone)}
                    </div>
                  </div>
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
                title="Zone overlay color"
              />
              <label className="flex items-center gap-2 text-xs md:col-span-2">
                <input
                  type="checkbox"
                  checked={zone.editorBgEnabled}
                  onChange={(event) => updateZone(zone.id, { editorBgEnabled: event.target.checked })}
                />
                Editor bg
              </label>
              <input
                type="color"
                value={zone.editorBgColor}
                onChange={(event) => updateZone(zone.id, { editorBgColor: event.target.value })}
                className="h-9 w-12 rounded border"
                title="Editor background color"
              />
              <label className="flex items-center gap-2 text-xs">
                Opacity
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={zone.editorBgOpacity}
                  onChange={(event) =>
                    updateZone(zone.id, {
                      editorBgOpacity: Math.max(0, Math.min(1, Number(event.target.value) || 0)),
                    })
                  }
                  className="w-16 rounded border px-1 py-0.5 text-xs"
                />
              </label>
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
