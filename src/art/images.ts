// The current image, uploaded to the backend once and shared by conversions
// and previews.

import type { ComputeBackend, ImageHandle } from "../engine/backend";
import type { SourceImage } from "./generate";

interface Entry {
  id: number;
  handle: Promise<ImageHandle>;
  leases: number;
}

export class ImageUploads {
  private current: Entry | null = null;

  constructor(private readonly backend: ComputeBackend) {}

  /**
   * Runs `fn` with the uploaded `image`, uploading it first when it is new.
   * A new image replaces the previous one, which is released as soon as no
   * run uses it any more.
   */
  async use<T>(image: SourceImage, fn: (handle: ImageHandle) => Promise<T>): Promise<T> {
    if (this.current?.id !== image.id) {
      const old = this.current;
      this.current = { id: image.id, handle: this.backend.uploadImage(image.rgba, image.width, image.height), leases: 0 };
      if (old) this.collect(old);
    }
    const entry = this.current!;
    entry.leases++;
    try {
      return await fn(await entry.handle);
    } catch (e) {
      // A failed upload is retried by the next run.
      if (this.current === entry && (await settled(entry.handle)) === "rejected") this.current = null;
      throw e;
    } finally {
      entry.leases--;
      this.collect(entry);
    }
  }

  dispose(): void {
    const old = this.current;
    this.current = null;
    if (old) this.collect(old);
  }

  private collect(entry: Entry): void {
    if (entry !== this.current && entry.leases === 0) entry.handle.then((h) => h.dispose(), () => {});
  }
}

function settled(p: Promise<unknown>): Promise<"fulfilled" | "rejected"> {
  return p.then(
    () => "fulfilled",
    () => "rejected",
  );
}
