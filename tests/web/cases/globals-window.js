// The Window profile's global surface: no Node name is reachable from a page, and
// the Web APIs this suite covers are. Pins `lava run --surface=web` (the flag the
// runner uses) against what a Chrome page sees.
const names = [
  'process',
  'require',
  'module',
  'exports',
  '__filename',
  '__dirname',
  'Buffer',
  'global',
  'setImmediate',
  'clearImmediate',
  '__lava_precache',
  '__lavaDrainNextTicks',
  '__lava_tl_drain',
];
for (const name of names) print(name + ' ' + typeof globalThis[name]);
print('typeof require ' + typeof require);
print('typeof process ' + typeof process);

const web = [
  'fetch',
  'Request',
  'Response',
  'Headers',
  'URL',
  'URLSearchParams',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'TextEncoder',
  'TextDecoder',
  'Blob',
  'File',
  'AbortController',
  'AbortSignal',
  'structuredClone',
  'atob',
  'btoa',
  'queueMicrotask',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
];
for (const name of web) print(name + ' ' + typeof globalThis[name]);
print('crypto ' + typeof crypto + ' ' + typeof crypto.getRandomValues);
print('performance ' + typeof performance + ' ' + typeof performance.now);
print('console ' + typeof console + ' ' + typeof console.log);
