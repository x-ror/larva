// The default abort and timeout reasons are DOMExceptions: name, legacy code,
// message, class and brand. Split from abort-signal.js so the behavior there is
// checked whatever shape the reason has.
print('DOMException ' + typeof DOMException);
const shape = (label, e) => {
  print(label + ' name ' + e.name + ' code ' + e.code + ' message ' + JSON.stringify(e.message));
  print(label + ' tag ' + Object.prototype.toString.call(e) + ' ctor ' + e.constructor.name);
  print(label + ' is Error ' + (e instanceof Error));
  print(label + ' own code ' + Object.prototype.hasOwnProperty.call(e, 'code'));
};
const c = new AbortController();
c.abort();
shape('abort()', c.signal.reason);
shape('AbortSignal.abort()', AbortSignal.abort().reason);
const t = AbortSignal.timeout(1);
t.addEventListener('abort', () => shape('timeout', t.reason));
