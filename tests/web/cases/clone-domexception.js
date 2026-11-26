// structuredClone of a DOMException (a serializable interface): the clone is a fresh
// DOMException — or QuotaExceededError, keeping quota/requested — with the same name
// and message and nothing else: no own properties, no stack, a page subclass comes
// back as DOMException. (An object that only inherits from DOMException.prototype is
// not one and clones as a plain object in Chrome; Lava's Error arm still brands by
// `instanceof Error`, and that arm is stage S4c's.)
const show = (label, c) =>
  print(
    label +
      ': ' +
      Object.prototype.toString.call(c) +
      ' ' +
      c.constructor.name +
      ' ' +
      c.name +
      ' ' +
      JSON.stringify(c.message) +
      ' ' +
      c.code +
      ' instanceof ' +
      (c instanceof DOMException) +
      ' own [' +
      Reflect.ownKeys(c).map(String).join(',') +
      '] stack ' +
      typeof c.stack +
      (c instanceof QuotaExceededError ? ' quota ' + c.quota + ' requested ' + c.requested : ''),
  );
show('AbortError', structuredClone(new DOMException('m', 'AbortError')));
show('unknown name', structuredClone(new DOMException('x', 'Weird')));
show('quota', structuredClone(new QuotaExceededError('q', { quota: 1, requested: 2 })));
show('quota empty', structuredClone(new QuotaExceededError('q')));
class Sub extends DOMException {}
show('subclass', structuredClone(new Sub('s', 'NotFoundError')));
show('abort reason', structuredClone(AbortSignal.abort().reason));
const d = new DOMException('m');
d.extra = 1;
show('own property', structuredClone(d));
show('nested', structuredClone({ e: new DOMException('in', 'DataError') }).e);
const both = new DOMException('same');
const pair = structuredClone([both, both]);
print('shared reference ' + (pair[0] === pair[1]));
