"use client";

import React, { useMemo, useRef, useState } from "react";
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
  bgEnabled?: boolean;
  bgColor?: string;
  padding?: number;
};

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export default function HomePage() {
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [templateUrl, setTemplateUrl] = useState<string | null>(null);

  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvPreview, setCsvPreview] = useState<Record<string, any>[]>([]);

  const [zones, setZones] = useState<Zone[]>([
    {
      id: uid(),
      name: "Title",
      x: 40,
      y: 40,
      w: 500,
      h: 120,
      fontSize: 48,
      align: "left",
      color: "#000000",
      bgEnabled: true,
      bgColor: "rgba(255,255,255,0.85)",
      padding: 10,
    },
  ]);

  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [activeZoneId, setActiveZoneId] = useState<string | null>(zones[0]?.id ?? null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  const [imgDisplay, setImgDisplay] = useState<{ w: number; h: number } | null>(null);

  const activeZone = useMemo(
    () => zones.find((z) => z.id === activeZoneId) ?? null,
    [zones, activeZoneId]
  );

  function onTemplatePicked(f: File | null) {
    setErr(null);
    setTemplateFile(f);
    setImgNatural(null);
    setImgDisplay(null);
    if (templateUrl) URL.revokeObjectURL(templateUrl);
    setTemplateUrl(f ? URL.createObjectURL(f) : null);
  }

  async function onCsvPicked(f: File | null) {
    setErr(null);
    setCsvFile(f);
    setCsvHeaders([]);
    setCsvPreview([]);
    if (!f) return;

    const text = await f.text();
    const parsed = Papa.parse<Record<string, any>>(text, {
      header: true,
      skipEmptyLines: true,
    });

    if (parsed.errors?.length) {
      setErr("CSV parse error. Check formatting and headers.");
      return;
    }

    const headers = (parsed.meta.fields ?? []).filter(Boolean) as string[];
    setCsvHeaders(headers);

    const preview = (parsed.data ?? []).slice(0, 8);
    setCsvPreview(preview);

    // auto-map by name (best effort)
    setMapping((prev) => {
      const next = { ...prev };
      for (const z of zones) {
        if (!next[z.id]) {
          const found =
            headers.find((h) => h.toLowerCase() === z.name.toLowerCase()) ||
            headers.find((h) => h.toLowerCase().includes(z.name.toLowerCase())) ||
            "";
          if (found) next[z.id] = found;
        }
      }
      return next;
    });
  }

  function addZone() {
    const z: Zone = {
      id: uid(),
      name: `Zone ${zones.length + 1}`,
      x: 60,
      y: 200 + zones.length * 40,
      w: 500,
      h: 120,
      fontSize: 28,
      align: "left",
      color: "#000000",
      bgEnabled: false,
      bgColor: "rgba(255,255,255,0.85)",
      padding: 10,
    };
    setZones((zs) => [...zs, z]);
    setActiveZoneId(z.id);
  }

  function removeActiveZone() {
    if (!activeZoneId) return;
    setZones((zs) => zs.filter((z) => z.id !== activeZoneId));
    setMapping((m) => {
      const copy = { ...m };
      delete copy[activeZoneId];
      return copy;
    });
    setActiveZoneId((prev) => {
      const remaining = zones.filter((z) => z.id !== prev);
      return remaining[0]?.id ?? null;
    });
  }

  function updateZone(id: string, patch: Partial<Zone>) {
    setZones((zs) => zs.map((z) => (z.id === id ? { ...z, ...patch } : z)));
  }

  function imgToNaturalCoords(x: number, y: number) {
    // Convert from displayed image coordinates to natural coordinates
    if (!imgNatural || !imgDisplay) return { x, y };
    const sx = imgNatural.w / imgDisplay.w;
    const sy = imgNatural.h / imgDisplay.h;
    return { x: Math.round(x * sx), y: Math.round(y * sy) };
  }

  function naturalToImgCoords(x: number, y: number) {
    if (!imgNatural || !imgDisplay) return { x, y };
    const sx = imgDisplay.w / imgNatural.w;
    const sy = imgDisplay.h / imgNatural.h;
    return { x: x * sx, y: y * sy };
  }

  async function generateZip() {
    setErr(null);
    if (!templateFile) return setErr("Upload a template PNG first.");
    if (!csvFile) return setErr("Upload a CSV file first.");
    if (!zones.length) return setErr("Add at least one zone.");

    // Require mapping for each zone
    for (const z of zones) {
      if (!mapping[z.id]) return setErr(`Map a CSV column for zone: "${z.name}"`);
    }

    // Ensure we have natural image size so we send correct coordinates to backend
    if (!imgNatural || !imgDisplay) {
      return setErr("Template image not loaded yet. Try again in a second.");
    }

    setBusy(true);
    try {
      // Convert zones from display coords to natural coords for correct rendering
      if (!imgNatural || !imgDisplay) {
        return setErr("Template image not loaded yet. Try again in a second.");
      }

      // Convert DISPLAY coords -> NATURAL coords ONCE, correctly
      const sx = imgNatural.w / imgDisplay.w;
      const sy = imgNatural.h / imgDisplay.h;

      const zonesNatural = zones.map((z) => ({
        ...z,
        x: Math.round(z.x * sx),
        y: Math.round(z.y * sy),
        w: Math.round(z.w * sx),
        h: Math.round(z.h * sy),
      }));

      
      
      const fd = new FormData();
      fd.append("template", templateFile);
      fd.append("csv", csvFile);
      fd.append("zones", JSON.stringify(zonesNatural));
      fd.append("mapping", JSON.stringify(mapping));

      const res = await fetch("/api/generate", { method: "POST", body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || "Generate failed");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = "labelforge.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setErr(e?.message ?? "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function sizeToNatural(w: number, h: number) {
    if (!imgNatural || !imgDisplay) return { w, h };
    const sx = imgNatural.w / imgDisplay.w;
    const sy = imgNatural.h / imgDisplay.h;
    return { w: Math.round(w * sx), h: Math.round(h * sy) };
  }

  function sizeToImg(w: number, h: number) {
    if (!imgNatural || !imgDisplay) return { w, h };
    const sx = imgDisplay.w / imgNatural.w;
    const sy = imgDisplay.h / imgNatural.h;
    return { w: w * sx, h: h * sy };
  }


  return (
    <main className="min-h-screen p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">LabelForge (MVP)</h1>
            <p className="text-sm text-neutral-600">
              Upload template PNG + CSV → place zones → map columns → generate PNG ZIP
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={generateZip}
              disabled={busy}
              className="rounded-xl bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              {busy ? "Generating..." : "Generate ZIP"}
            </button>
          </div>
        </header>

        {err && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}

        <section className="grid gap-6 lg:grid-cols-[1.4fr_0.6fr]">
          {/* Left: Template + Zones */}
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm font-medium">Template PNG:</label>
              <input
                type="file"
                accept="image/png"
                onChange={(e) => onTemplatePicked(e.target.files?.[0] ?? null)}
              />
              <button
                onClick={addZone}
                className="rounded-xl border px-3 py-1.5 text-sm hover:bg-neutral-50"
              >
                + Add Zone
              </button>
              <button
                onClick={removeActiveZone}
                disabled={!activeZoneId}
                className="rounded-xl border px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
              >
                Remove Zone
              </button>
            </div>

            <div className="mt-4">
              {!templateUrl ? (
                <div className="rounded-xl border border-dashed p-10 text-center text-sm text-neutral-600">
                  Upload a PNG template to start.
                </div>
              ) : (
                <div className="relative inline-block">
                  <img
                    ref={imgRef}
                    src={templateUrl}
                    alt="template"
                    className="max-w-full rounded-xl border select-none"
                    draggable={false}
                    onLoad={() => {
                      const img = imgRef.current!;
                      const rect = img.getBoundingClientRect();
                      setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
                      setImgDisplay({ w: Math.round(rect.width), h: Math.round(rect.height) });
                    }}
                  />

                  {imgDisplay && (
                    <div
                      className="absolute left-0 top-0"
                      style={{ width: imgDisplay.w, height: imgDisplay.h }}
                    >
                      {zones.map((z) => {
                        // IMPORTANT: for MVP store zones in DISPLAY COORDS directly
                        // so no conversion here
                        const isActive = z.id === activeZoneId;

                        return (
                          <Rnd
                            key={z.id}
                            size={{ width: z.w, height: z.h }}
                            position={{ x: z.x, y: z.y }}
                            bounds="parent"
                            enableResizing
                            onMouseDown={() => setActiveZoneId(z.id)}
                            onDragStop={(e, d) => updateZone(z.id, { x: d.x, y: d.y })}
                            onResizeStop={(e, dir, ref, delta, pos) => {
                              updateZone(z.id, {
                                x: pos.x,
                                y: pos.y,
                                w: ref.offsetWidth,
                                h: ref.offsetHeight,
                              });
                            }}
                            style={{
                              border: isActive ? "2px solid #000" : "2px solid rgba(0,0,0,0.35)",
                              background: isActive ? "rgba(0,0,0,0.05)" : "rgba(0,0,0,0.02)",
                              borderRadius: 12,
                            }}
                          >
                            {/* pointer-events-none so Rnd always gets the drag */}
                            <div className="h-full w-full p-2 text-xs pointer-events-none">
                              <div className="font-semibold">{z.name}</div>
                              <div className="opacity-70">
                                {mapping[z.id] ? `← ${mapping[z.id]}` : "unmapped"}
                              </div>
                            </div>
                          </Rnd>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

            </div>
          </div>

          {/* Right: CSV + Mapping + Zone Settings */}
          <div className="space-y-6">
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium">CSV Upload:</label>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => onCsvPicked(e.target.files?.[0] ?? null)}
                />
              </div>

              {csvHeaders.length > 0 && (
                <div className="mt-3 text-xs text-neutral-600">
                  Detected columns:{" "}
                  <span className="text-neutral-900">{csvHeaders.join(", ")}</span>
                </div>
              )}

              {csvPreview.length > 0 && (
                <div className="mt-3 overflow-auto rounded-xl border">
                  <table className="min-w-full text-xs">
                    <thead className="bg-neutral-50">
                      <tr>
                        {csvHeaders.slice(0, 6).map((h) => (
                          <th key={h} className="px-2 py-2 text-left font-medium">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {csvPreview.map((row, idx) => (
                        <tr key={idx} className="border-t">
                          {csvHeaders.slice(0, 6).map((h) => (
                            <td key={h} className="px-2 py-2 align-top">
                              {String(row[h] ?? "").slice(0, 60)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="text-sm font-semibold">Zone Settings</div>
              {!activeZone ? (
                <div className="mt-2 text-sm text-neutral-600">Select a zone.</div>
              ) : (
                <div className="mt-3 space-y-3 text-sm">
                  <div>
                    <label className="text-xs text-neutral-600">Name</label>
                    <input
                      className="mt-1 w-full rounded-xl border px-3 py-2"
                      value={activeZone.name}
                      onChange={(e) => updateZone(activeZone.id, { name: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="text-xs text-neutral-600">Map to CSV Column</label>
                    <select
                      className="mt-1 w-full rounded-xl border px-3 py-2"
                      value={mapping[activeZone.id] ?? ""}
                      onChange={(e) =>
                        setMapping((m) => ({ ...m, [activeZone.id]: e.target.value }))
                      }
                      disabled={csvHeaders.length === 0}
                    >
                      <option value="">Select column…</option>
                      {csvHeaders.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                    {csvHeaders.length === 0 && (
                      <div className="mt-1 text-xs text-neutral-500">Upload CSV to map columns.</div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-neutral-600">Font Size</label>
                      <input
                        type="number"
                        className="mt-1 w-full rounded-xl border px-3 py-2"
                        value={activeZone.fontSize}
                        onChange={(e) =>
                          updateZone(activeZone.id, { fontSize: Number(e.target.value) })
                        }
                        min={8}
                        max={120}
                      />
                    </div>

                    <div>
                      <label className="text-xs text-neutral-600">Text Align</label>
                      <select
                        className="mt-1 w-full rounded-xl border px-3 py-2"
                        value={activeZone.align}
                        onChange={(e) =>
                          updateZone(activeZone.id, {
                            align: e.target.value as Zone["align"],
                          })
                        }
                      >
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-xs text-neutral-600">Text Color</label>
                      <input
                        type="color"
                        className="mt-1 h-10 w-full rounded-xl border px-3 py-2"
                        value={activeZone.color}
                        onChange={(e) =>
                          updateZone(activeZone.id, { color: e.target.value })
                        }
                      />
                    </div>

                    <div>
                      <label className="text-xs text-neutral-600">Padding</label>
                      <input
                        type="number"
                        className="mt-1 w-full rounded-xl border px-3 py-2"
                        value={activeZone.padding ?? 10}
                        onChange={(e) =>
                          updateZone(activeZone.id, { padding: Number(e.target.value) })
                        }
                        min={0}
                        max={60}
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between rounded-xl border p-3">
                    <div>
                      <div className="text-sm font-medium">Background box</div>
                      <div className="text-xs text-neutral-600">
                        Makes text readable over photos
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={!!activeZone.bgEnabled}
                      onChange={(e) =>
                        updateZone(activeZone.id, { bgEnabled: e.target.checked })
                      }
                    />
                  </div>

                  {activeZone.bgEnabled && (
                    <div>
                      <label className="text-xs text-neutral-600">
                        Background (CSS rgba)
                      </label>
                      <input
                        className="mt-1 w-full rounded-xl border px-3 py-2"
                        value={activeZone.bgColor ?? "rgba(255,255,255,0.85)"}
                        onChange={(e) =>
                          updateZone(activeZone.id, { bgColor: e.target.value })
                        }
                        placeholder='rgba(255,255,255,0.85)'
                      />
                    </div>
                  )}

                  <div className="pt-2">
                    <div className="text-xs text-neutral-500">
                      Tip: Drag/resize zones on the image. Mapping controls which CSV column
                      fills each zone.
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-2xl border bg-white p-4 text-xs text-neutral-600 shadow-sm">
              MVP limit: 200 rows per run (we’ll expand in Phase 2).
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
