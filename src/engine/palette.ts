// The lookup tables the hot loops run on, and the records of which blocks were seen.

import type { Resolved } from "./mapping/resolver";
import { needsTileEntity } from "./mapping/tileEntities";

export class PaletteTable {
  ids = new Uint8Array(0);
  data = new Uint8Array(0);
  special = new Uint8Array(0);
  counts = new Float64Array(0);
  resolved: (Resolved | undefined)[] = [];

  ensure(size: number): void {
    if (size <= this.ids.length) {
      return;
    }
    const capacity = Math.max(size, this.ids.length * 2, 64);
    const grow = <T extends Uint8Array | Float64Array>(old: T, next: T): T => {
      next.set(old);
      return next;
    };
    this.ids = grow(this.ids, new Uint8Array(capacity));
    this.data = grow(this.data, new Uint8Array(capacity));
    this.special = grow(this.special, new Uint8Array(capacity));
    this.counts = grow(this.counts, new Float64Array(capacity));
  }

  set(index: number, block: Resolved): void {
    this.ensure(index + 1);
    this.ids[index] = block.id;
    this.data[index] = block.data;
    this.special[index] = needsTileEntity(block.id) ? 1 : 0;
    this.resolved[index] = block;
  }
}

// Positions of blocks that carry a tile entity, kept in flat arrays so even a map full of
// signs stays compact. Positions from file-order sources arrive already sorted.
export class SpecialIndex {
  private positions = new Float64Array(1024);
  private blocks = new Int32Array(1024);
  private consumed: Uint8Array | null = null;
  private order: Uint32Array | null = null;
  size = 0;
  private sorted = true;

  push(position: number, block: number): void {
    if (this.size === this.positions.length) {
      const positions = new Float64Array(this.size * 2);
      positions.set(this.positions);
      this.positions = positions;
      const blocks = new Int32Array(this.size * 2);
      blocks.set(this.blocks);
      this.blocks = blocks;
    }
    if (this.size > 0 && position < this.positions[this.size - 1]!) {
      this.sorted = false;
    }
    this.positions[this.size] = position;
    this.blocks[this.size] = block;
    this.size += 1;
  }

  finalize(): void {
    if (this.consumed) {
      return;
    }
    this.consumed = new Uint8Array(this.size);
    if (!this.sorted) {
      const order = new Uint32Array(this.size);
      for (let i = 0; i < this.size; i++) {
        order[i] = i;
      }
      const positions = this.positions;
      order.sort((a, b) => positions[a]! - positions[b]!);
      this.order = order;
    }
  }

  private positionAt(rank: number): number {
    return this.positions[this.order ? this.order[rank]! : rank]!;
  }

  // Finds the block at a position and marks it as handled.
  take(position: number): number | undefined {
    let low = 0;
    let high = this.size - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const value = this.positionAt(middle);
      if (value === position) {
        const actual = this.order ? this.order[middle]! : middle;
        this.consumed![actual] = 1;
        return this.blocks[actual];
      }
      if (value < position) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return undefined;
  }

  *remaining(): Generator<[number, number]> {
    for (let i = 0; i < this.size; i++) {
      if (!this.consumed![i]) {
        yield [this.positions[i]!, this.blocks[i]!];
      }
    }
  }
}

export interface BlockRecord {
  count: number;
  data: number;
  id: number;
  kind: Resolved["kind"];
  name: string;
  overridden: boolean;
}

// Report rows, grouped by block name with the most common target for that name.
export function collectBlockRecords(palette: PaletteTable): BlockRecord[] {
  const byName = new Map<string, BlockRecord & { best: number }>();
  for (let index = 0; index < palette.resolved.length; index++) {
    const block = palette.resolved[index];
    const count = palette.counts[index] ?? 0;
    if (!block || count === 0) {
      continue;
    }
    const existing = byName.get(block.name);
    if (!existing) {
      byName.set(block.name, {
        best: count,
        count,
        data: block.data,
        id: block.id,
        kind: block.kind,
        name: block.name,
        overridden: block.overridden,
      });
      continue;
    }
    existing.count += count;
    if (count > existing.best) {
      existing.best = count;
      existing.id = block.id;
      existing.data = block.data;
    }
  }
  return [...byName.values()]
    .map(({ best: _best, ...record }) => record)
    .sort((a, b) => b.count - a.count);
}
