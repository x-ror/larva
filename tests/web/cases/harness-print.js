// The print shim itself, on both hosts: one String(value) per line, a single string
// argument printed verbatim (no format directives), non-ASCII as UTF-8, and a poisoned
// String/console after the shim is installed changing nothing it writes.
print('plain');
print('%s %d %o %% stays literal');
print('');
print(42);
print(-0);
print(null);
print(undefined);
print(true);
print([1, [2, 3]]);
print({});
print(Symbol('s').toString());
print('héllo ☕ 日本語 😀');
print('tab\there');
print('two\nlines');
print(JSON.stringify('lone \ud800 surrogate'));

const RealString = String;
globalThis.String = () => 'POISONED';
console.log = () => {};
print('after poisoning String and console.log');
globalThis.String = RealString;
