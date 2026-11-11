// Font loading actions (presets, URLs, files) with progress and notices.

import { useCallback, useEffect, useRef, useState } from "react";
import { isAbort } from "../engine/backend";
import { PRESETS, loadPreset } from "../fonts/presets";
import { type FontSource, type LoadReport, loadFontUrl } from "../fonts/sources";
import type { FontStore } from "../fonts/store";
import { errorText, useNotify } from "./notices";
import { plural } from "./text";

export interface FontLoading {
  label: string;
  phase: string;
  done: number;
  total: number;
}

type Update = (phase: string, done: number, total: number) => void;

type JobKind = "preset" | "add";

export function useFontLoader(store: FontStore) {
  const notify = useNotify();
  const [jobs, setJobs] = useState<Partial<Record<JobKind, FontLoading>>>({});
  const current = useRef<Partial<Record<JobKind, AbortController>>>({});

  const begin = (kind: JobKind, label: string) => {
    current.current[kind]?.abort();
    const ctrl = new AbortController();
    current.current[kind] = ctrl;
    const set = (v: FontLoading | undefined) => setJobs((j) => ({ ...j, [kind]: v }));
    set({ label, phase: "Starting", done: 0, total: 0 });
    const update = (phase: string, done: number, total: number) => {
      if (current.current[kind] === ctrl) set({ label, phase, done, total });
    };
    const end = () => {
      if (current.current[kind] === ctrl) {
        delete current.current[kind];
        set(undefined);
      }
    };
    return { ctrl, update, end };
  };

  const report = useCallback(
    (what: string, warnings: string[], added: number) => {
      if (warnings.length) {
        notify(
          added ? "warning" : "error",
          `${what}: ${plural(warnings.length, "problem")}${added ? `, ${plural(added, "font")} loaded anyway` : ", nothing was loaded"}.`,
          warnings,
        );
      }
    },
    [notify],
  );

  const addSources = useCallback(
    async (label: string, produce: (signal: AbortSignal, update: Update) => Promise<LoadReport> | LoadReport) => {
      const job = begin("add", label);
      try {
        const r = await produce(job.ctrl.signal, job.update);
        const warnings = [...r.warnings];
        let added = 0;
        for (let i = 0; i < r.fonts.length; i++) {
          job.ctrl.signal.throwIfAborted();
          job.update("Registering fonts", i, r.fonts.length);
          const res = await store.add(r.fonts[i]);
          warnings.push(...res.warnings);
          if (res.font) added++;
        }
        report(label, warnings, added);
        if (!warnings.length && added) notify("info", `Added ${plural(added, "font")}.`);
      } catch (e) {
        if (!isAbort(e)) notify("error", `${label}: ${errorText(e)}`);
      } finally {
        job.end();
      }
    },
    [store, notify, report],
  );

  const addUrl = useCallback(
    (url: string) =>
      addSources("Font URL", (signal, update) =>
        loadFontUrl(url, signal, (d, t) => update("Downloading files", d, t)),
      ),
    [addSources],
  );

  const addFiles = useCallback(
    (files: File[]) =>
      addSources("Font files", async (signal, update) => {
        const fonts: FontSource[] = [];
        const warnings: string[] = [];
        for (let i = 0; i < files.length; i++) {
          signal.throwIfAborted();
          update("Reading files", i, files.length);
          try {
            const bytes = new Uint8Array(await files[i].arrayBuffer());
            fonts.push({
              name: files[i].name,
              faces: [{ bytes, unicodeRange: null, label: files[i].name }],
              preferFamilyName: true,
            });
          } catch {
            warnings.push(`${files[i].name}: the file could not be read.`);
          }
        }
        return { fonts, warnings };
      }),
    [addSources],
  );

  const applyPreset = useCallback(
    async (id: string) => {
      const preset = PRESETS.find((p) => p.id === id);
      if (!preset) return;
      const job = begin("preset", preset.label);
      try {
        const r = await loadPreset(preset, job.ctrl.signal, (p) =>
          job.update(p.phase === "stylesheets" ? "Fetching stylesheets" : "Downloading files", p.done, p.total),
        );
        if (preset.families.length && r.fonts.length === 0) {
          notify("error", `${preset.label}: no font could be downloaded. Check the network connection.`, r.warnings);
          return;
        }
        const warnings = await store.replace(r.fonts, job.ctrl.signal, (d, t) => job.update("Registering fonts", d, t));
        report(preset.label, [...r.warnings, ...warnings], r.fonts.length);
      } catch (e) {
        if (!isAbort(e)) notify("error", `${preset.label}: ${errorText(e)}`);
      } finally {
        job.end();
      }
    },
    [store, notify, report],
  );

  const cancel = useCallback(() => {
    for (const c of Object.values(current.current)) c?.abort();
    current.current = {};
    setJobs({});
  }, []);

  useEffect(
    () => () => {
      for (const c of Object.values(current.current)) c?.abort();
    },
    [],
  );

  const loading = [jobs.preset, jobs.add].filter((j): j is FontLoading => !!j);
  return { loading, addUrl, addFiles, applyPreset, cancel };
}
