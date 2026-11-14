// heap.js — Binary min-heap (priority queue) backed by typed arrays.
//
// Used as A*'s "open list": always gives back the cell with the LOWEST f = g + h.
// - push: O(log n)   pop: O(log n)   (a sorted array would be O(n) per insert)
// - Typed arrays (Float64Array / Int32Array) instead of objects: no garbage
//   collection pauses, contiguous memory, ~5-10x faster in the hot loop.
// - No decrease-key: when we find a better path to a cell we just push it again
//   ("lazy deletion"); A* skips the stale copy when it's popped (closed[] check).

export class MinHeap {
  constructor(capacity = 1 << 16) {
    this.keys = new Float64Array(capacity); // priorities (f-score)
    this.vals = new Int32Array(capacity);   // payload (cell index)
    this.size = 0;
  }

  push(key, val) {
    if (this.size === this.keys.length) this._grow();
    // sift-up: move parents down until we find where `key` fits
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;               // parent index
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }

  pop() {
    const top = this.vals[0];
    const n = --this.size;
    if (n > 0) {
      // take the last element and sift it down from the root
      const k = this.keys[n], v = this.vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;                  // left child
        if (c >= n) break;
        if (c + 1 < n && this.keys[c + 1] < this.keys[c]) c++; // smaller child
        if (this.keys[c] >= k) break;
        this.keys[i] = this.keys[c];
        this.vals[i] = this.vals[c];
        i = c;
      }
      this.keys[i] = k;
      this.vals[i] = v;
    }
    return top;
  }

  _grow() {
    const k = new Float64Array(this.keys.length * 2); k.set(this.keys); this.keys = k;
    const v = new Int32Array(this.vals.length * 2);   v.set(this.vals); this.vals = v;
  }
}
