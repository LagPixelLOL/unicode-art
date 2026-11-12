// The shared image upload: one upload per image, released when unused.

import { describe, expect, it, vi } from "vitest";
import type { SourceImage } from "../../src/art/generate";
import { ImageUploads } from "../../src/art/images";
import type { ComputeBackend, ImageHandle } from "../../src/engine/backend";

const img = (id: number) => ({ id, name: `${id}`, width: 2, height: 1, limited: false, rgba: new Uint8ClampedArray(8) }) as SourceImage;

function fakeBackend() {
  const handles: (ImageHandle & { disposed: boolean })[] = [];
  let fail = false;
  const backend = {
    uploadImage: vi.fn(async (_rgba: Uint8ClampedArray, width: number, height: number) => {
      if (fail) throw new Error("upload failed");
      const h = { width, height, disposed: false, dispose: () => void (h.disposed = true) };
      handles.push(h);
      return h;
    }),
  };
  return { backend: backend as unknown as ComputeBackend & typeof backend, handles, failNext: (v: boolean) => (fail = v) };
}

describe("ImageUploads", () => {
  it("uploads each image once and shares it between concurrent uses", async () => {
    const { backend, handles } = fakeBackend();
    const uploads = new ImageUploads(backend);
    const a = img(1);
    const seen = await Promise.all([uploads.use(a, async (h) => h), uploads.use({ ...a }, async (h) => h)]);
    expect(seen[0]).toBe(seen[1]);
    await uploads.use(a, async () => {});
    expect(backend.uploadImage).toHaveBeenCalledTimes(1);
    expect(handles[0].disposed).toBe(false);
  });

  it("releases a replaced image once no run uses it", async () => {
    const { backend, handles } = fakeBackend();
    const uploads = new ImageUploads(backend);
    let release!: () => void;
    const running = uploads.use(img(1), () => new Promise<void>((r) => (release = r)));
    await vi.waitFor(() => expect(handles).toHaveLength(1));
    await uploads.use(img(2), async () => {});
    // Still in use by the first run.
    expect(handles[0].disposed).toBe(false);
    release();
    await running;
    await Promise.resolve();
    expect(handles[0].disposed).toBe(true);
    expect(handles[1].disposed).toBe(false);
    uploads.dispose();
    await Promise.resolve();
    expect(handles[1].disposed).toBe(true);
  });

  it("retries a failed upload and passes errors of the run through", async () => {
    const { backend, failNext } = fakeBackend();
    const uploads = new ImageUploads(backend);
    failNext(true);
    await expect(uploads.use(img(1), async () => {})).rejects.toThrow(/upload failed/);
    failNext(false);
    await expect(uploads.use(img(1), async () => Promise.reject(new Error("run failed")))).rejects.toThrow(/run failed/);
    // The upload itself worked, so it is kept.
    expect(await uploads.use(img(1), async () => 7)).toBe(7);
    expect(backend.uploadImage).toHaveBeenCalledTimes(2);
  });
});
