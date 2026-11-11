import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SourceImage } from "../art/generate";
import { type DomCheck, type DomMeasurements, evaluateDom } from "../art/verify";
import type { ComputeBackend, ExclusionRule } from "../engine/backend";
import { DEFAULT_PRESET, PRESETS, loadGoogleFamilies } from "../fonts/presets";
import { FontStore } from "../fonts/store";
import { classifyFile, decodeImage, imageFromItems } from "../image/load";
import { Badge, Progress, Section, buttonClass, inputClass } from "./common";
import { ExclusionInfo } from "./ExclusionInfo";
import { FontList, isInternalDrag } from "./FontList";
import { errorText, useNotify } from "./notices";
import { DETAIL_RANGE, WIDTH_RANGE, readOptions } from "./options";
import { OutputBox } from "./OutputBox";
import { asciiOnly, plural } from "./text";
import { Timing } from "./Timing";
import { type RunStage, useConversion } from "./useConversion";
import { useFontLoader } from "./useFontLoader";

const STAGE_LABEL: Record<RunStage, string> = {
  fonts: "Loading fonts",
  charset: "Measuring characters",
  glyphs: "Rasterizing glyphs",
  target: "Preparing image",
  match: "Matching glyphs on the GPU",
  verify: "Verifying the native rendering",
};

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export function App({ backend }: { backend: ComputeBackend }) {
  const notify = useNotify();
  const store = useMemo(
    () =>
      new FontStore(backend, (families, signal, onProgress) =>
        loadGoogleFamilies(families, signal, (p) => p.phase === "files" && onProgress(p.done, p.total)),
      ),
    [backend],
  );
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const fontLoader = useFontLoader(store);
  const conversion = useConversion(backend, store);
  const { state, result, canvasCheck, verifyMs, lastTotalMs } = conversion;
  const [rules, setRules] = useState<ExclusionRule[]>([]);
  const [image, setImage] = useState<SourceImage | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [widthText, setWidthText] = useState("80");
  const [detailText, setDetailText] = useState("10");
  const [invert, setInvert] = useState(false);
  const [presetId, setPresetId] = useState(DEFAULT_PRESET);
  const [fontUrl, setFontUrl] = useState("");
  const [domCheck, setDomCheck] = useState<DomCheck | null>(null);
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const [lost, setLost] = useState<string | null>(null);
  const [runKey, setRunKey] = useState<string | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);

  const options = readOptions(widthText, detailText, invert);
  const inputKey = `${image?.id}|${typeof options === "string" ? options : JSON.stringify(options)}|${entries.map((e) => e.id).join(",")}`;
  const stale = !!result && runKey !== null && runKey !== inputKey && !conversion.running;

  useEffect(() => {
    backend.exclusionRules().then(setRules, (e) => notify("error", `Could not load the exclusion rules: ${errorText(e)}`));
    void backend.lost.then((reason) => {
      setLost(reason);
      notify("error", `${reason} Reload the page to continue.`);
    });
  }, [backend, notify]);

  // The default preset only fills the list; fonts download on first use.
  const { applyPreset } = fontLoader;
  useEffect(() => applyPreset(DEFAULT_PRESET), [applyPreset]);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const verified = canvasCheck && domCheck ? canvasCheck.pass && domCheck.pass : null;
  useEffect(() => {
    if (verified === false) {
      notify("warning", "The browser rendering differs from the computed result. See the verification details in the status panel.");
    }
  }, [verified, result, notify]);

  const onLayout = useCallback((m: DomMeasurements) => result && setDomCheck(evaluateDom(result, m)), [result]);
  useEffect(() => setDomCheck(null), [result]);

  const loadImage = useCallback(
    async (blob: Blob, name: string) => {
      try {
        const img = await decodeImage(blob, asciiOnly(name));
        if (img.limited) notify("info", `${img.name} was scaled down to ${img.width} x ${img.height} to limit memory use.`);
        setImage(img);
        setPreview(URL.createObjectURL(blob));
      } catch (e) {
        notify("error", errorText(e));
      }
    },
    [notify],
  );

  // Paste and drop anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = imageFromItems(e.clipboardData?.items ?? []);
      if (file) {
        e.preventDefault();
        void loadImage(file, file.name || "pasted image");
      } else if (!isEditable(e.target)) {
        notify("info", "The clipboard does not contain an image. Copy an image, not a link or text, and paste again.");
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (isInternalDrag(e.dataTransfer) || !e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (isInternalDrag(e.dataTransfer) || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      const fontFiles = files.filter((f) => classifyFile(f) === "font");
      const images = files.filter((f) => classifyFile(f) === "image");
      const other = files.filter((f) => classifyFile(f) === null);
      if (other.length) {
        notify("warning", `Ignored ${plural(other.length, "file")} that is neither an image nor a font.`, other.map((f) => f.name));
      }
      if (images.length > 1) notify("info", "Several images were dropped; the last one is used.");
      if (fontFiles.length) void fontLoader.addFiles(fontFiles);
      const img = images.at(-1);
      if (img) void loadImage(img, img.name);
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [loadImage, notify, fontLoader.addFiles]);

  const blocker = lost
    ? "The GPU is no longer available. Reload the page."
    : typeof options === "string"
      ? options
      : !image
        ? "Upload, paste or drop an image."
        : entries.length === 0
          ? "Add a font or pick a preset."
          : null;

  const startOrCancel = () => {
    if (conversion.running) {
      conversion.cancel();
      return;
    }
    if (blocker || !image || typeof options === "string") return;
    setRunKey(inputKey);
    void conversion.start({ image, options });
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied("ok");
    } catch {
      setCopied("fail");
      notify("error", "Copying failed: the browser denied clipboard access. Select the text in the output and copy it manually.");
    }
    setTimeout(() => setCopied(""), 1500);
  };

  const provided = useMemo(() => (result ? new Map(result.families.map((f, i) => [f, result.provided[i]])) : null), [result]);
  const used = useMemo(() => {
    if (!result) return null;
    const sets = result.families.map(() => new Set<number>());
    for (const g of result.layout.glyphs) sets[result.glyphFont[g]].add(g);
    return new Map(result.families.map((f, i) => [f, sets[i].size]));
  }, [result]);

  let status: { text: string; tone: string; progress: number };
  if (lost) status = { text: `${lost} Reload the page to continue.`, tone: "text-red-400", progress: 0 };
  else if (state.kind === "running") {
    status = { text: `${STAGE_LABEL[state.stage]}${state.detail ? `: ${state.detail}` : "..."}`, tone: "text-zinc-400", progress: state.progress };
  } else if (state.kind === "error") status = { text: state.message, tone: "text-red-400", progress: 0 };
  else if (state.kind === "cancelled") status = { text: "Cancelled.", tone: "text-zinc-400", progress: 0 };
  else if (state.kind === "done") {
    status = {
      text: `Done. ${verified === null ? "Verifying the page layout..." : verified ? "Verified." : "Verification found differences."}`,
      tone: verified === false ? "text-amber-400" : "text-emerald-400",
      progress: 1,
    };
  } else status = { text: blocker ?? "Ready. Press Start to convert.", tone: "text-zinc-400", progress: 0 };

  const appState = lost
    ? "error"
    : state.kind === "done"
      ? verified === null
        ? "verifying"
        : verified
          ? "ok"
          : "mismatch"
      : state.kind;
  const s = result?.stats;

  return (
    <div className="flex h-full flex-col overflow-x-hidden overflow-y-auto md:overflow-hidden" data-state={appState}>
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3 md:px-5">
        <h1 className="text-base font-semibold tracking-tight">Unicode Art</h1>
        <p className="hidden text-sm text-zinc-500 lg:block">Turn an image into text made from the characters of your fonts.</p>
        <span className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">Backend: {backend.label}</span>
      </header>

      <div className="flex flex-col md:min-h-0 md:flex-1 md:flex-row">
        <aside className="flex w-full min-w-0 shrink-0 flex-col gap-6 border-zinc-800 p-4 md:w-96 md:overflow-x-hidden md:overflow-y-auto md:border-r md:p-5">
          <section className="space-y-2" aria-label="Conversion">
            <button
              type="button"
              onClick={startOrCancel}
              disabled={!conversion.running && !!blocker}
              data-testid="start-button"
              className={`w-full rounded-md px-3 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500 ${
                conversion.running ? "bg-red-900 text-red-100 hover:bg-red-800" : "bg-zinc-100 text-zinc-900 hover:bg-white"
              }`}
            >
              {conversion.running ? "Cancel" : "Start"}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!result}
                onClick={copy}
                data-testid="copy-button"
                className={`${buttonClass} flex-1 py-2`}
              >
                {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy text"}
              </button>
              {result && lastTotalMs !== null && <Timing result={result} totalMs={lastTotalMs} verifyMs={verifyMs} />}
            </div>
            {result && s && (
              <p
                className="text-xs text-zinc-500"
                data-testid="stats"
                title={
                  `Candidates dropped: ${s.excluded.mismatched} with mismatching browser advance, ` +
                  `${s.excluded.tooNarrow} narrower than one sample, ${s.excluded.tooWide} too wide, ` +
                  `${s.duplicates} identical to another glyph.`
                }
              >
                {`${plural(result.rows, "line")}, ${plural(s.characters, "character")}, ${s.distinct.toLocaleString("en-US")} distinct of ` +
                  `${s.candidates.toLocaleString("en-US")} candidates, RMS error ${s.rmsError.toFixed(3)}`}
              </p>
            )}
            {stale && (
              <p className="text-xs text-amber-400" data-testid="stale">
                The inputs changed since this output was made. Press Start to convert again.
              </p>
            )}
          </section>

          <Section title="Image">
            <button
              type="button"
              onClick={() => imageInput.current?.click()}
              className="w-full rounded-md border border-dashed border-zinc-700 bg-zinc-900 px-3 py-4 text-sm text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800"
            >
              Choose an image
            </button>
            <input
              ref={imageInput}
              data-testid="image-input"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void loadImage(f, f.name);
              }}
            />
            <p className="mt-2 text-xs text-zinc-500">
              Or paste an image anywhere on the page (Ctrl+V), or drop one anywhere. A new image replaces the current one.
              Transparent areas become white; colors become grey.
            </p>
            {image && preview && (
              <div className="mt-3 flex min-w-0 items-center gap-3">
                <img src={preview} alt="Selected image" className="h-16 w-16 shrink-0 rounded border border-zinc-800 bg-white object-contain" />
                <div className="min-w-0 text-xs break-all text-zinc-400" data-testid="image-meta">
                  {image.name}, {image.width} x {image.height}
                </div>
              </div>
            )}
          </Section>

          <Section title="Fonts" extra={<ExclusionInfo rules={rules} />}>
            <div className="flex min-w-0 gap-2">
              <select
                aria-label="Font preset"
                data-testid="preset-select"
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
                className={`${inputClass} min-w-0 flex-1 py-1.5 text-sm`}
              >
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`${buttonClass} shrink-0`}
                disabled={conversion.running}
                onClick={() => applyPreset(presetId)}
              >
                Replace list
              </button>
            </div>
            <button type="button" className={`${buttonClass} mt-2 w-full`} onClick={() => fontInput.current?.click()}>
              Upload font files
            </button>
            <input
              ref={fontInput}
              data-testid="font-input"
              type="file"
              multiple
              accept=".ttf,.otf,.ttc,.otc,.woff,.woff2,font/*"
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) void fontLoader.addFiles(files);
              }}
            />
            <form
              className="mt-2 flex min-w-0 gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const url = fontUrl.trim();
                if (url) void fontLoader.addUrl(url).then(() => setFontUrl(""));
              }}
            >
              <input
                type="text"
                inputMode="url"
                aria-label="Font or stylesheet URL"
                value={fontUrl}
                onChange={(e) => setFontUrl(e.target.value)}
                placeholder="https://.../font.woff2 or a CSS URL"
                className={`${inputClass} min-w-0 flex-1 py-1.5 text-sm`}
              />
              <button type="submit" className={`${buttonClass} shrink-0`} disabled={!fontUrl.trim()}>
                Add
              </button>
            </form>
            {fontLoader.loading && (
              <div className="mt-3 space-y-1" data-testid="font-loading">
                <div className="flex items-center gap-2 text-xs text-zinc-400">
                  <span className="min-w-0 flex-1 truncate">
                    {fontLoader.loading.label}: {fontLoader.loading.phase}
                    {fontLoader.loading.total ? ` ${fontLoader.loading.done} / ${fontLoader.loading.total}` : "..."}
                  </span>
                  <button type="button" className="text-zinc-500 underline hover:text-zinc-200" onClick={fontLoader.cancel}>
                    Cancel
                  </button>
                </div>
                <Progress value={fontLoader.loading.total ? fontLoader.loading.done / fontLoader.loading.total : 0} />
              </div>
            )}
            <div className="mt-3">
              <FontList
                fonts={entries}
                provided={provided}
                used={used}
                onMove={(a, b) => store.move(a, b)}
                onRemove={(id) => store.remove(id)}
              />
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              Drag to reorder. A character missing from a font is looked up in the fonts below it; characters no font
              has are never used. Preset fonts come from Google Fonts and are downloaded when you press Start.
            </p>
          </Section>

          <Section title="Options">
            <div className="space-y-3">
              <label className="flex items-center justify-between gap-3 text-sm text-zinc-300">
                <span>Max width (cells)</span>
                <input
                  type="number"
                  data-testid="opt-width"
                  min={WIDTH_RANGE[0]}
                  max={WIDTH_RANGE[1]}
                  step={1}
                  value={widthText}
                  onChange={(e) => setWidthText(e.target.value)}
                  className={`${inputClass} w-24 text-right`}
                />
              </label>
              <label className="flex items-center justify-between gap-3 text-sm text-zinc-300">
                <span>Detail (samples per cell)</span>
                <input
                  type="number"
                  data-testid="opt-detail"
                  min={DETAIL_RANGE[0]}
                  max={DETAIL_RANGE[1]}
                  step={1}
                  value={detailText}
                  onChange={(e) => setDetailText(e.target.value)}
                  className={`${inputClass} w-24 text-right`}
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  data-testid="opt-invert"
                  checked={invert}
                  onChange={(e) => setInvert(e.target.checked)}
                  className="h-4 w-4 accent-zinc-400"
                />
                <span>Flip black and white</span>
              </label>
              <p className="text-xs text-zinc-500">
                A cell is the width of the digit 0 in the font stack. Lines never exceed the max width; the height
                follows the image. By default bright areas get dense characters, as the output is light text on black.
              </p>
            </div>
          </Section>

          <Section title="Status">
            <p className={`text-sm break-words ${status.tone}`} aria-live="polite" data-testid="status">
              {status.text}
            </p>
            <div className="mt-2">
              <Progress value={status.progress} label="Conversion progress" />
            </div>
            {result && (
              <ul className="mt-3 space-y-1 text-xs" aria-label="Verification" data-testid="verification">
                <li className="flex items-start gap-2" data-result={canvasCheck ? (canvasCheck.pass ? "pass" : "fail") : "pending"}>
                  <Badge ok={canvasCheck ? canvasCheck.pass : null} />
                  <span className="min-w-0 text-zinc-400">
                    Native text render vs computed glyphs
                    {canvasCheck &&
                      `: ${(canvasCheck.similarity * 100).toFixed(2)}% similar` +
                        (canvasCheck.pass
                          ? ""
                          : `, worst line ${canvasCheck.worstRow + 1} at ${(canvasCheck.worstRowSimilarity * 100).toFixed(1)}%`)}
                  </span>
                </li>
                <li className="flex items-start gap-2" data-result={domCheck ? (domCheck.pass ? "pass" : "fail") : "pending"}>
                  <Badge ok={domCheck ? domCheck.pass : null} />
                  <span className="min-w-0 text-zinc-400">
                    Page layout vs computed positions
                    {domCheck &&
                      `: max error ${domCheck.maxPositionError.toFixed(2)} px over ${plural(domCheck.checkedGlyphs, "glyph")}, ` +
                        `line width ${domCheck.maxWidthError.toFixed(2)} px, baseline ${domCheck.baselineError.toFixed(2)} px` +
                        (domCheck.textMatches ? "" : ", text differs")}
                  </span>
                </li>
              </ul>
            )}
          </Section>
        </aside>

        <main className="order-first flex h-[60vh] min-w-0 shrink-0 flex-col p-3 md:order-none md:h-auto md:flex-1 md:shrink md:p-4">
          <OutputBox
            result={result}
            busy={conversion.running}
            placeholder={conversion.running ? "Working..." : (blocker ?? "Press Start to convert.")}
            onLayout={onLayout}
          />
        </main>
      </div>
    </div>
  );
}
