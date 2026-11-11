// Font actions: presets (lazy), URLs and files (loaded right away).

import { useCallback, useEffect, useRef, useState } from "react";
import { isAbort } from "../engine/backend";
import { PRESETS } from "../fonts/presets";
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

export function useFontLoader(store: FontStore) {
  const notify = useNotify();
  const [loading, setLoading] = useState<FontLoading | null>(null);
  const current = useRef<AbortController | null>(null);

  const addSources = useCallback(
    async (label: string, produce: (signal: AbortSignal, update: Update) => Promise<LoadReport> | LoadReport) => {
      current.current?.abort();
      const ctrl = new AbortController();
      current.current = ctrl;
      const update: Update = (phase, done, total) => {
        if (current.current === ctrl) setLoading({ label, phase, done, total });
      };
      update("Starting", 0, 0);
      try {
        const r = await produce(ctrl.signal, update);
        const warnings = [...r.warnings];
        let added = 0;
        for (let i = 0; i < r.fonts.length; i++) {
          ctrl.signal.throwIfAborted();
          update("Registering fonts", i, r.fonts.length);
          const res = await store.add(r.fonts[i]);
          warnings.push(...res.warnings);
          if (res.font) added++;
        }
        if (warnings.length) {
          notify(
            added ? "warning" : "error",
            `${label}: ${plural(warnings.length, "problem")}${added ? `, ${plural(added, "font")} added anyway` : ", nothing was added"}.`,
            warnings,
          );
        } else if (added) {
          notify("info", `Added ${plural(added, "font")} at the end of the list.`);
        }
      } catch (e) {
        if (!isAbort(e)) notify("error", `${label}: ${errorText(e)}`);
      } finally {
        if (current.current === ctrl) {
          current.current = null;
          setLoading(null);
        }
      }
    },
    [store, notify],
  );

  const addUrl = useCallback(
    (url: string) =>
      addSources("Font URL", (signal, update) => loadFontUrl(url, signal, (d, t) => update("Downloading files", d, t))),
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
            fonts.push({ name: files[i].name, faces: [{ bytes, unicodeRange: null, label: files[i].name }], preferFamilyName: true });
          } catch {
            warnings.push(`${files[i].name}: the file could not be read.`);
          }
        }
        return { fonts, warnings };
      }),
    [addSources],
  );

  /** Replaces the list; nothing is downloaded until a conversion needs it. */
  const applyPreset = useCallback(
    (id: string) => {
      const preset = PRESETS.find((p) => p.id === id);
      if (preset) store.setRemote(preset.fonts);
    },
    [store],
  );

  const cancel = useCallback(() => {
    current.current?.abort();
    current.current = null;
    setLoading(null);
  }, []);

  useEffect(() => () => current.current?.abort(), []);

  return { loading, addUrl, addFiles, applyPreset, cancel };
}
