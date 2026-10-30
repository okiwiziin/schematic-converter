// Random-access block storage for sources that aren't in file order: structure files and
// litematics with several regions. Pages live in memory up to a budget and spill to a
// scratch file beyond it. Untouched pages are never allocated, so a mostly empty bounding
// box costs almost nothing.
import { closeSync, openSync, readSync, rmSync, writeSync } from "node:fs";

const PAGE_BITS = 22;
const PAGE_SIZE = 1 << PAGE_BITS;

interface Page {
  data: Uint8Array;
  ids: Uint8Array;
}

export class BlockCanvas {
  private readonly pages = new Map<number, Page>();
  private readonly onDisk = new Set<number>();
  private lastPageIndex = -1;
  private lastPage: Page | null = null;
  private fd: number | null = null;

  constructor(
    readonly volume: number,
    private readonly scratchPath: string,
    private readonly maxPages = 128
  ) {}

  private page(index: number): Page {
    if (index === this.lastPageIndex && this.lastPage) {
      return this.lastPage;
    }
    let page = this.pages.get(index);
    if (page) {
      // Re-inserting keeps the Map ordered from least to most recently used.
      this.pages.delete(index);
      this.pages.set(index, page);
    } else {
      page = this.load(index);
      this.pages.set(index, page);
      if (this.pages.size > this.maxPages) {
        this.evictOldest();
      }
    }
    this.lastPageIndex = index;
    this.lastPage = page;
    return page;
  }

  private load(index: number): Page {
    const page = {
      data: new Uint8Array(PAGE_SIZE),
      ids: new Uint8Array(PAGE_SIZE),
    };
    if (this.onDisk.has(index)) {
      const fd = this.scratch();
      const offset = index * PAGE_SIZE * 2;
      readSync(fd, page.ids, 0, PAGE_SIZE, offset);
      readSync(fd, page.data, 0, PAGE_SIZE, offset + PAGE_SIZE);
    }
    return page;
  }

  private scratch(): number {
    this.fd ??= openSync(this.scratchPath, "w+");
    return this.fd;
  }

  private evictOldest(): void {
    const oldest = this.pages.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    const page = this.pages.get(oldest)!;
    const fd = this.scratch();
    const offset = oldest * PAGE_SIZE * 2;
    writeSync(fd, page.ids, 0, PAGE_SIZE, offset);
    writeSync(fd, page.data, 0, PAGE_SIZE, offset + PAGE_SIZE);
    this.onDisk.add(oldest);
    this.pages.delete(oldest);
    if (this.lastPageIndex === oldest) {
      this.lastPageIndex = -1;
      this.lastPage = null;
    }
  }

  set(index: number, id: number, data: number): void {
    const page = this.page(Math.floor(index / PAGE_SIZE));
    const offset = index % PAGE_SIZE;
    page.ids[offset] = id;
    page.data[offset] = data;
  }

  // Calls `emit` with every block in order, then frees the storage.
  async drain(
    emit: (ids: Uint8Array, data: Uint8Array, count: number) => Promise<void>
  ): Promise<void> {
    const zeros = new Uint8Array(PAGE_SIZE);
    const pageCount = Math.ceil(this.volume / PAGE_SIZE);
    for (let index = 0; index < pageCount; index++) {
      const count = Math.min(PAGE_SIZE, this.volume - index * PAGE_SIZE);
      const inMemory = this.pages.get(index);
      if (inMemory) {
        await emit(inMemory.ids, inMemory.data, count);
        this.pages.delete(index);
      } else if (this.onDisk.has(index)) {
        const page = this.load(index);
        await emit(page.ids, page.data, count);
      } else {
        await emit(zeros, zeros, count);
      }
    }
    this.lastPage = null;
    this.lastPageIndex = -1;
    this.close();
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
      rmSync(this.scratchPath, { force: true });
    }
  }
}
