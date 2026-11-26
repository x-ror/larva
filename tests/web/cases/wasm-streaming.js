// WebAssembly.compileStreaming / instantiateStreaming exist on a page in every mainstream
// browser; they are the embedder's (Blink's, over a Response), so Larva owes them. Their
// absence is a fingerprint, and a known gap (known-gaps.txt) until they are implemented
// over Response: a stub that only rejected would be worse, since loaders that find the
// function stop taking their ArrayBuffer fallback.
for (const k of ['compileStreaming', 'instantiateStreaming']) {
  const f = WebAssembly[k];
  print(k + ' ' + typeof f + (typeof f === 'function' ? ' ' + f.name + ' ' + f.length : ''));
}
