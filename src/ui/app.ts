// Application wiring: inputs, conversion runs, output and verification.

import { type ArtOptions, type ArtResult, ArtGenerator, type SourceImage, type Stage } from "../art/generate";
import { type CanvasCheck, type DomCheck, evaluateDom, verifyCanvas } from "../art/verify";
import { type ComputeBackend, isAbort } from "../engine/backend";
import { type FontSource, fetchFontSources } from "../fonts/sources";
import { FontStore } from "../fonts/store";
import { classifyFile, decodeImage, imageFromItems } from "../image/load";
import { FontListView, isInternalDrag } from "./fontList";
import { OutputView } from "./output";
import { asciiOnly, plural, summarizeExclusions } from "./text";

const STAGE_LABEL: Record<Stage, string> = {
  charset: "Measuring characters",
  glyphs: "Rasterizing glyphs",
  target: "Preparing image",
  match: "Matching glyphs on the GPU",
};

export function readOptions(width: string, detail: string, invert: boolean): ArtOptions | string {
  const w = Number(width);
  const d = Number(detail);
  if (!Number.isInteger(w) || w < 1 || w > 1000) return "Max width must be a whole number from 1 to 1000.";
  if (!Number.isInteger(d) || d < 2 || d > 32) return "Detail must be a whole number from 2 to 32.";
  return { widthCells: w, detail: d, invert };
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e as T;
}

function message(e: unknown): string {
  return asciiOnly(e instanceof Error ? e.message : String(e));
}

export async function startApp(backend: ComputeBackend): Promise<void> {
  const app = el("app");
  app.classList.remove("hidden");
  app.classList.add("flex");
  el("backend-label").textContent = `Backend: ${backend.label}`;

  const statusEl = el("status");
  const progressEl = el("progress");
  const verifyEl = el<HTMLUListElement>("verify");
  const statsEl = el("stats");
  const copyBtn = el<HTMLButtonElement>("copy-button");
  const fontError = el("font-error");
  const widthInput = el<HTMLInputElement>("opt-width");
  const detailInput = el<HTMLInputElement>("opt-detail");
  const invertInput = el<HTMLInputElement>("opt-invert");

  renderExclusions(el("exclusions-panel"), await backend.exclusionRules());

  const store = new FontStore(backend);
  const list = new FontListView(el<HTMLOListElement>("font-list"), store);
  const generator = new ArtGenerator(backend);
  let image: SourceImage | null = null;
  let previewUrl = "";
  let controller: AbortController | null = null;
  let timer = 0;
  let lastCanvas: CanvasCheck | null = null;

  const output = new OutputView(el("output-box"), el("output-placeholder"), () => {
    const r = output.current;
    if (r) renderVerification(lastCanvas, evaluateDom(r, output.measure()));
  });

  const setStatus = (text: string, tone: "info" | "error" | "ok" = "info") => {
    statusEl.textContent = text;
    statusEl.className = `text-sm ${tone === "error" ? "text-red-400" : tone === "ok" ? "text-emerald-400" : "text-zinc-400"}`;
    app.dataset.state = tone === "info" ? "busy" : tone;
  };
  const setProgress = (f: number) => {
    progressEl.style.width = `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;
  };

  const showFontError = (text: string) => {
    fontError.textContent = text;
    fontError.classList.toggle("hidden", !text);
  };

  function renderVerification(canvas: CanvasCheck | null, dom: DomCheck | null): void {
    const items: [boolean | null, string][] = [];
    if (canvas) {
      items.push([
        canvas.pass,
        `Native text render vs computed glyphs: ${(canvas.similarity * 100).toFixed(2)}% similar` +
          (canvas.pass ? "" : `, worst line ${canvas.worstRow + 1} at ${(canvas.worstRowSimilarity * 100).toFixed(1)}%`),
      ]);
    } else {
      items.push([null, "Native text render vs computed glyphs: checking"]);
    }
    if (dom) {
      items.push([
        dom.pass,
        `Page layout vs computed positions: max error ${dom.maxPositionError.toFixed(2)} px over ${plural(dom.checkedGlyphs, "glyph")}, ` +
          `line width ${dom.maxWidthError.toFixed(2)} px, baseline ${dom.baselineError.toFixed(2)} px` +
          (dom.textMatches ? "" : ", text differs"),
      ]);
    }
    verifyEl.replaceChildren(
      ...items.map(([ok, text]) => {
        const li = document.createElement("li");
        li.className = "flex gap-2";
        const badge = document.createElement("span");
        badge.className = `shrink-0 rounded px-1.5 font-medium ${ok === null ? "bg-zinc-800 text-zinc-400" : ok ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"}`;
        badge.textContent = ok === null ? "..." : ok ? "PASS" : "FAIL";
        const span = document.createElement("span");
        span.className = "text-zinc-400";
        span.textContent = text;
        li.append(badge, span);
        li.dataset.result = ok === null ? "pending" : ok ? "pass" : "fail";
        return li;
      }),
    );
  }

  function updateContributions(r: ArtResult | null): void {
    list.contributions.clear();
    if (r) {
      const used = new Map<number, Set<number>>();
      for (const g of r.layout.glyphs) {
        const fi = r.glyphFont[g];
        if (!used.has(fi)) used.set(fi, new Set());
        used.get(fi)!.add(g);
      }
      store.fonts.forEach((f, i) => list.contributions.set(f.id, used.get(i)?.size ?? 0));
    }
    list.render();
  }

  async function run(): Promise<void> {
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    const options = readOptions(widthInput.value, detailInput.value, invertInput.checked);
    copyBtn.disabled = true;
    verifyEl.replaceChildren();
    lastCanvas = null;
    if (typeof options === "string") {
      setStatus(options, "error");
      return;
    }
    if (store.fonts.length === 0 || !image) {
      output.clear(!image ? "Upload or paste an image." : "Add at least one font.");
      statsEl.textContent = "";
      setProgress(0);
      updateContributions(null);
      setStatus(
        store.fonts.length === 0 && !image
          ? "Add a font and an image to begin."
          : store.fonts.length === 0
            ? "Add at least one font."
            : "Upload or paste an image.",
        "ok",
      );
      app.dataset.state = "idle";
      return;
    }
    const started = performance.now();
    try {
      const result = await generator.generate(store.fonts, image, options, ctrl.signal, (stage, f) => {
        setStatus(`${STAGE_LABEL[stage]}...`);
        setProgress(f);
      });
      if (ctrl.signal.aborted) return;
      output.show(result);
      copyBtn.disabled = false;
      updateContributions(result);
      const s = result.stats;
      statsEl.textContent =
        `${plural(result.rows, "line")}, ${plural(s.characters, "character")}, ${s.distinct.toLocaleString("en-US")} distinct of ` +
        `${s.candidates.toLocaleString("en-US")} candidates, RMS error ${s.rmsError.toFixed(3)}`;
      statsEl.title =
        `Charset ${s.ms.charset.toFixed(0)} ms, glyphs ${s.ms.glyphs.toFixed(0)} ms, image ${s.ms.target.toFixed(0)} ms, ` +
        `GPU match and layout ${s.ms.match.toFixed(0)} ms. Dropped: ${s.excluded.mismatched} with mismatching browser ` +
        `advance, ${s.excluded.tooNarrow} narrower than one sample, ${s.excluded.tooWide} wider than 3 cells.`;
      setProgress(1);
      setStatus(`Done in ${((performance.now() - started) / 1000).toFixed(2)} s. Verifying...`);
      const dom = evaluateDom(result, output.measure());
      renderVerification(null, dom);
      const canvas = await verifyCanvas(result, backend);
      if (ctrl.signal.aborted) return;
      lastCanvas = canvas;
      const finalDom = evaluateDom(result, output.measure());
      renderVerification(canvas, finalDom);
      const ok = canvas.pass && finalDom.pass;
      setStatus(
        `Done in ${((performance.now() - started) / 1000).toFixed(2)} s. ${ok ? "Verified." : "Verification found differences."}`,
        ok ? "ok" : "error",
      );
    } catch (e) {
      if (isAbort(e) || ctrl.signal.aborted) return;
      console.error(e);
      setProgress(0);
      setStatus(message(e), "error");
    }
  }

  const schedule = (delay = 250) => {
    clearTimeout(timer);
    timer = window.setTimeout(run, delay);
  };

  async function setImage(blob: Blob, name: string): Promise<void> {
    try {
      setStatus("Decoding image...");
      const img = await decodeImage(blob, asciiOnly(name));
      image = img;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob);
      el<HTMLImageElement>("image-preview").src = previewUrl;
      el("image-meta").textContent = `${img.name}, ${img.width} x ${img.height}`;
      el("image-info").classList.replace("hidden", "flex");
      schedule(0);
    } catch (e) {
      setStatus(message(e), "error");
    }
  }

  async function addFonts(sources: FontSource[] | Promise<FontSource[]>): Promise<void> {
    showFontError("");
    const errors: string[] = [];
    try {
      for (const s of await sources) {
        try {
          await store.add(asciiOnly(s.name), s.bytes);
        } catch (e) {
          errors.push(message(e));
        }
      }
    } catch (e) {
      errors.push(message(e));
    }
    showFontError(errors.join(" "));
  }

  const filesToSources = (files: File[]) =>
    Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));

  store.onChange(() => {
    list.render();
    schedule(0);
  });

  el("image-button").addEventListener("click", () => el<HTMLInputElement>("image-input").click());
  el<HTMLInputElement>("image-input").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) void setImage(f, f.name);
    input.value = "";
  });
  el("font-button").addEventListener("click", () => el<HTMLInputElement>("font-input").click());
  el<HTMLInputElement>("font-input").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length) void addFonts(filesToSources(files));
  });
  el<HTMLFormElement>("font-url-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = el<HTMLInputElement>("font-url");
    const url = input.value.trim();
    if (!url) return;
    void addFonts(fetchFontSources(url)).then(() => {
      if (fontError.classList.contains("hidden")) input.value = "";
    });
  });
  for (const input of [widthInput, detailInput]) input.addEventListener("input", () => schedule());
  invertInput.addEventListener("change", () => schedule(0));

  window.addEventListener("paste", (e) => {
    const file = imageFromItems(e.clipboardData?.items ?? []);
    if (!file) return;
    e.preventDefault();
    void setImage(file, file.name || "pasted image");
  });
  window.addEventListener("dragover", (e) => {
    if (isInternalDrag(e.dataTransfer) || !e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("drop", (e) => {
    if (isInternalDrag(e.dataTransfer) || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    const fonts = files.filter((f) => classifyFile(f) === "font");
    const img = files.filter((f) => classifyFile(f) === "image").pop();
    if (fonts.length) void addFonts(filesToSources(fonts));
    if (img) void setImage(img, img.name);
  });

  copyBtn.addEventListener("click", async () => {
    const r = output.current;
    if (!r) return;
    try {
      await navigator.clipboard.writeText(r.text);
      copyBtn.textContent = "Copied";
    } catch {
      copyBtn.textContent = "Copy failed";
    }
    setTimeout(() => (copyBtn.textContent = "Copy text"), 1500);
  });

  void backend.lost.then((reason) => {
    controller?.abort();
    setStatus(`${asciiOnly(reason)} Reload the page to continue.`, "error");
    copyBtn.disabled = true;
  });

  list.render();
  void run();
}

function renderExclusions(panel: HTMLElement, rules: Awaited<ReturnType<ComputeBackend["exclusionRules"]>>): void {
  const s = summarizeExclusions(rules);
  const p = (text: string, cls = "") => {
    const e = document.createElement("p");
    e.className = cls;
    e.textContent = text;
    return e;
  };
  const h = (text: string) => p(text, "mt-3 font-medium text-zinc-200");
  const ranges = document.createElement("ul");
  ranges.className = "mt-1 space-y-0.5";
  for (const r of s.ranges) {
    const li = document.createElement("li");
    const key = document.createElement("span");
    key.className = "font-mono text-zinc-400";
    key.textContent = r.key;
    li.append(key, ` ${r.description}`);
    ranges.append(li);
  }
  panel.replaceChildren(
    p("Only characters that render as one standalone left-to-right advance are used. Excluded:", "text-zinc-200"),
    h("Unicode general categories"),
    p(s.categories),
    h("Bidi classes"),
    p(s.bidi),
    h("Blocks needing complex shaping, joining or sequences"),
    ranges,
    h("Per font, at run time"),
    p(
      "Code points no loaded font maps to a real glyph, glyphs with zero advance, characters whose browser " +
        "advance disagrees with the font, and glyphs narrower than one sample or wider than 3 cells.",
    ),
  );
}
