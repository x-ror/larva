// Blob construction and reads. Blob is the byte container a page actually holds
// (fetch bodies, File, object URLs), and both reads settle through the event loop,
// so these are the benchAsync rows: each iteration awaits one read.
//   blob-new          construction from mixed string + byte parts, the copy-in path
//   blob-text         utf-8 decode of a ~4 KB body
//   blob-arraybuffer  the same body copied out as bytes
//   blob-slice        a slice of the body, read back only for its size

const part = 'héllo wörld — 日本語 '.repeat(160);
const bytes = new TextEncoder().encode(part);
const blob = new Blob([part]);

bench('blob-new', () => new Blob([part, bytes, part]).size, { iterations: 1500 });
benchAsync('blob-text', () => blob.text(), { iterations: 4000 });
benchAsync('blob-arraybuffer', () => blob.arrayBuffer(), { iterations: 5000 });
bench('blob-slice', () => blob.slice(100, 2000).size, { iterations: 100000 });
