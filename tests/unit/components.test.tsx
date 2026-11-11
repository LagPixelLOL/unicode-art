// @vitest-environment happy-dom
// React components in a simulated DOM.

import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputeBackend } from "../../src/engine/backend";
import { googleFont } from "../../src/fonts/presets";
import type { FontEntry } from "../../src/fonts/store";
import { App } from "../../src/ui/App";
import { ExclusionInfo } from "../../src/ui/ExclusionInfo";
import { FontList } from "../../src/ui/FontList";
import { NoticeProvider, useNotify } from "../../src/ui/notices";
import { Unsupported } from "../../src/ui/Unsupported";
import { installFakeCanvas } from "./helpers/fakeCanvas";

afterEach(cleanup);

function entry(id: number, name: string, status: FontEntry["status"] = "pending", extra: Partial<FontEntry> = {}): FontEntry {
  return { id, family: `uaf-${id}`, name, status, remote: googleFont(name), error: null, font: null, ...extra };
}

const readyFont = (id: number, name: string): FontEntry =>
  entry(id, name, "ready", {
    remote: null,
    font: {
      id,
      family: `uaf-${id}`,
      name,
      faces: [{}, {}] as never,
      coverage: new Uint32Array(1500),
      advanceEm: new Float32Array(1500),
      isVariable: true,
      ascentEm: 1,
      descentEm: 0.3,
      formats: ["woff2"],
      colorGlyphs: 0,
      bytes: 3 * 1024 * 1024 + 300 * 1024,
    },
  });

describe("FontList", () => {
  it("shows status and statistics and moves fonts with buttons", () => {
    const onMove = vi.fn();
    const onRemove = vi.fn();
    const fonts = [
      readyFont(1, "Noto Sans"),
      entry(2, "Noto Sans JP"),
      entry(3, "Broken", "failed", { error: "no usable font file" }),
      entry(4, "Loading", "loading"),
      entry(5, "gg", "pending", { remote: { kind: "url", name: "gg", url: "https://raw.githubusercontent.com/x/y.woff2" } }),
    ];
    render(<FontList fonts={fonts} provided={new Map([["uaf-1", 1200]])} used={new Map([["uaf-1", 12]])} onMove={onMove} onRemove={onRemove} />);
    const items = screen.getAllByTestId("font-item");
    expect(items).toHaveLength(5);
    expect(items[0].textContent).toContain("1. Noto Sans");
    expect(items[0].textContent).toContain("WOFF2, 2 files, 3.3 MiB, variable, 1,500 chars, provides 1,200, 12 used");
    expect(items[1].textContent).toContain("Downloaded from Google Fonts when you press Start");
    expect(items[2].textContent).toContain("Failed: no usable font file");
    expect(items[3].textContent).toContain("Downloading...");
    expect(items[4].textContent).toContain("Downloaded from raw.githubusercontent.com when you press Start");
    expect(within(items[0]).getByLabelText("Move up")).toHaveProperty("disabled", true);
    expect(within(items[4]).getByLabelText("Move down")).toHaveProperty("disabled", true);
    fireEvent.click(within(items[1]).getByLabelText("Move up"));
    fireEvent.click(within(items[1]).getByLabelText("Move down"));
    fireEvent.click(within(items[2]).getByLabelText("Remove font"));
    expect(onMove.mock.calls).toEqual([
      [1, 0],
      [1, 2],
    ]);
    expect(onRemove).toHaveBeenCalledWith(3);
  });

  it("reorders by drag and drop and ignores foreign drags", () => {
    const onMove = vi.fn();
    render(<FontList fonts={[entry(1, "A"), entry(2, "B"), entry(3, "C")]} provided={null} used={null} onMove={onMove} onRemove={() => {}} />);
    const items = screen.getAllByTestId("font-item");
    const data = new Map<string, string>();
    const dataTransfer = {
      get types() {
        return [...data.keys()];
      },
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      effectAllowed: "",
      dropEffect: "",
    };
    const at = (type: "dragOver" | "drop", el: HTMLElement, clientY: number) => {
      el.getBoundingClientRect = () => ({ top: 0, height: 20 }) as DOMRect;
      const ev = createEvent[type](el, { dataTransfer });
      Object.defineProperty(ev, "clientY", { value: clientY });
      fireEvent(el, ev);
    };
    fireEvent.dragStart(items[0], { dataTransfer });
    at("dragOver", items[2], 15);
    expect(items[2].getAttribute("data-drop")).toBe("bottom");
    expect(screen.getAllByTestId("drop-bar")).toHaveLength(1);
    // Hovering next to the dragged item itself shows no bar.
    at("dragOver", items[1], 5);
    expect(screen.queryByTestId("drop-bar")).toBeNull();
    at("dragOver", items[1], 15);
    expect(items[1].getAttribute("data-drop")).toBe("bottom");
    at("dragOver", items[2], 15);
    at("drop", items[2], 15);
    expect(onMove).toHaveBeenLastCalledWith(0, 2);
    fireEvent.dragStart(items[2], { dataTransfer });
    at("drop", items[0], 5);
    expect(onMove).toHaveBeenLastCalledWith(2, 0);
    fireEvent.dragEnd(items[0], { dataTransfer });
    fireEvent.drop(items[1], { dataTransfer: { types: ["Files"], getData: () => "" } });
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it("can be locked while fonts are in use", () => {
    const onMove = vi.fn();
    render(<FontList fonts={[entry(1, "A"), entry(2, "B")]} provided={null} used={null} onMove={onMove} onRemove={onMove} locked />);
    const items = screen.getAllByTestId("font-item");
    expect(items[0].getAttribute("draggable")).toBe("false");
    for (const b of within(items[1]).getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it("has an empty state", () => {
    render(<FontList fonts={[]} provided={null} used={null} onMove={() => {}} onRemove={() => {}} />);
    expect(screen.getByText("No fonts loaded.")).toBeTruthy();
  });
});

describe("notices", () => {
  function Trigger({ details }: { details?: string[] }) {
    const notify = useNotify();
    return (
      <>
        <button onClick={() => notify("error", "Broken caf\u00e9", details)}>err</button>
        <button onClick={() => notify("info", "Hello")}>info</button>
      </>
    );
  }

  it("shows ASCII only notices with details, dismisses and deduplicates", () => {
    const details = Array.from({ length: 25 }, (_, i) => `problem ${i}`);
    render(
      <NoticeProvider>
        <Trigger details={details} />
      </NoticeProvider>,
    );
    fireEvent.click(screen.getByText("err"));
    fireEvent.click(screen.getByText("err"));
    const notice = screen.getByTestId("notice");
    expect(screen.getAllByTestId("notice")).toHaveLength(1);
    expect(notice.textContent).toContain("Broken caf?");
    expect(notice.getAttribute("role")).toBe("alert");
    fireEvent.click(screen.getByText("Show details (25)"));
    expect(screen.getByText("problem 0")).toBeTruthy();
    expect(screen.getByText("and 5 more")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByTestId("notice")).toBeNull();
  });

  it("closes info notices automatically", () => {
    vi.useFakeTimers();
    render(
      <NoticeProvider>
        <Trigger />
      </NoticeProvider>,
    );
    fireEvent.click(screen.getByText("info"));
    expect(screen.getByTestId("notice").getAttribute("data-tone")).toBe("info");
    act(() => vi.advanceTimersByTime(7000));
    expect(screen.queryByTestId("notice")).toBeNull();
    vi.useRealTimers();
  });
});

describe("panels", () => {
  it("shows the exclusion summary in a popover on hover", () => {
    render(
      <ExclusionInfo
        rules={[
          { kind: "category", key: "Mn", description: "nonspacing combining marks" },
          { kind: "bidi", key: "R", description: "right-to-left letters" },
          { kind: "range", key: "U+0590-U+08FF", description: "Hebrew, Arabic" },
        ]}
      />,
    );
    expect(screen.queryByTestId("exclusions-panel")).toBeNull();
    const button = screen.getByLabelText("Which characters are excluded");
    fireEvent.mouseEnter(button);
    const panel = screen.getByTestId("exclusions-panel");
    expect(panel.parentElement).toBe(document.body);
    expect(panel.textContent).toContain("Mn (nonspacing combining marks)");
    expect(panel.textContent).toContain("U+0590-U+08FF Hebrew, Arabic");
    expect(panel.textContent).toContain("color glyphs");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("exclusions-panel")).toBeNull();
  });

  it("explains unsupported browsers", () => {
    render(<Unsupported failures={[{ label: "WebGPU + WebAssembly", reasons: ["WebGPU is not available.", "No \u00fcber adapter"] }]} />);
    expect(screen.getByText("This browser is not supported")).toBeTruthy();
    const reasons = screen.getByTestId("unsupported-reasons").textContent!;
    expect(reasons).toContain("WebGPU + WebAssembly: WebGPU is not available.");
    expect(reasons).toContain("No ?ber adapter");
  });
});

describe("App", () => {
  function stubBackend(): ComputeBackend {
    return {
      id: "stub",
      label: "Stub backend",
      lost: new Promise(() => {}),
      exclusionRules: async () => [{ kind: "category", key: "Mn", description: "marks" }],
      parseFont: async () => {
        throw new Error("not a TTF");
      },
      mergeCoverage: async () => {
        throw new Error("unused");
      },
      prepareTarget: async () => new Float32Array(),
      createGlyphBankBuilder: async () => {
        throw new Error("unused");
      },
      layout: async () => {
        throw new Error("unused");
      },
      compareImages: async () => {
        throw new Error("unused");
      },
      dispose() {},
    };
  }

  it("lists the default preset lazily and only converts on Start", async () => {
    installFakeCanvas();
    const fetchSpy = vi.fn(async () => new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("createImageBitmap", async () => ({ width: 20, height: 10, close() {} }));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL() {} }));
    render(
      <NoticeProvider>
        <App backend={stubBackend()} />
      </NoticeProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId("font-item").length).toBeGreaterThan(150));
    expect(screen.getByTestId("font-size").textContent).toMatch(/^No font downloaded yet, \d+ fonts not downloaded yet/);
    // Nothing is downloaded until a conversion needs it.
    expect(fetchSpy).not.toHaveBeenCalled();
    const start = screen.getByTestId("start-button") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByTestId("status").textContent).toBe("Upload, paste or drop an image.");

    // Pasting text outside of inputs explains that an image is needed.
    fireEvent(window, Object.assign(new Event("paste"), { clipboardData: { items: [] } }));
    await waitFor(() => expect(screen.getByTestId("notice").textContent).toContain("does not contain an image"));

    // An image enables Start but does not convert by itself.
    const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("image-input"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId("image-meta").textContent).toBe("photo.png, 20 x 10"));
    expect(start.disabled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Invalid options block Start with a reason.
    fireEvent.change(screen.getByTestId("opt-width"), { target: { value: "0" } });
    expect(start.disabled).toBe(true);
    expect(screen.getByTestId("status").textContent).toMatch(/Max width/);
    fireEvent.change(screen.getByTestId("opt-width"), { target: { value: "40" } });

    // Choosing a preset replaces the list at once, without converting.
    const select = screen.getByTestId("preset-select") as HTMLSelectElement;
    expect(select.value).toBe("noto-sans-all");
    fireEvent.change(select, { target: { value: "noto-sans" } });
    await waitFor(() => expect(screen.getAllByTestId("font-item")).toHaveLength(4));
    expect(select.value).toBe("noto-sans");
    expect(fetchSpy).not.toHaveBeenCalled();
    // Editing the list makes it custom; undoing the edit finds the preset again.
    fireEvent.click(within(screen.getAllByTestId("font-item")[0]).getByLabelText("Move down"));
    await waitFor(() => expect(select.value).toBe("custom"));
    expect(screen.getByRole("option", { name: "Custom" })).toBeTruthy();
    fireEvent.click(within(screen.getAllByTestId("font-item")[1]).getByLabelText("Move up"));
    await waitFor(() => expect(select.value).toBe("noto-sans"));
    expect(screen.queryByRole("option", { name: "Custom" })).toBeNull();
    fireEvent.change(select, { target: { value: "noto-mono" } });
    await waitFor(() => expect(screen.getAllByTestId("font-item")).toHaveLength(1));

    // Start downloads the fonts; the failure is reported and Start comes back.
    fireEvent.click(start);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toMatch(/No font is available/));
    expect(fetchSpy).toHaveBeenCalled();
    expect(start.textContent).toBe("Start");
    expect(screen.getAllByTestId("notice").some((n) => n.getAttribute("data-tone") === "error")).toBe(true);
    expect(screen.getAllByTestId("font-item")[0].textContent).toContain("Failed");
    expect(screen.getByTestId("font-size").textContent).toBe("No font downloaded yet, 1 failed.");
    vi.unstubAllGlobals();
  });

  it("cancels at once", async () => {
    installFakeCanvas();
    let release!: () => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((r) => (release = () => r(new Response("", { status: 500 })))));
    vi.stubGlobal("createImageBitmap", async () => ({ width: 4, height: 4, close() {} }));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL() {} }));
    render(
      <NoticeProvider>
        <App backend={stubBackend()} />
      </NoticeProvider>,
    );
    fireEvent.change(screen.getByTestId("image-input"), { target: { files: [new File([new Uint8Array(4)], "a.png", { type: "image/png" })] } });
    const start = screen.getByTestId("start-button") as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(start.textContent).toBe("Cancel"));
    expect(screen.getByTestId("status").textContent).toMatch(/Loading fonts/);
    fireEvent.click(start);
    expect(start.textContent).toBe("Start");
    expect(screen.getByTestId("status").textContent).toBe("Cancelled.");
    release?.();
    await waitFor(() => expect(screen.getAllByTestId("font-item")[0].textContent).toContain("when you press Start"));
    vi.unstubAllGlobals();
  });
});
