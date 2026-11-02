export function selectIds(ids: readonly string[], seed: number, count: number): string[] {
  const ordered = [...ids].sort();
  const random = mulberry32(seed);
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = ordered[index];
    const other = ordered[swap];
    if (current === undefined || other === undefined) {
      throw new Error("sample index was empty");
    }
    ordered[index] = other;
    ordered[swap] = current;
  }
  return ordered.slice(0, count);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
