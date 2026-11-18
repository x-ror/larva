// events.once({ signal }), listenerCount(type, listener), setMaxListeners validation,
// and newListener / removeListener meta-events (#105).
const { EventEmitter, once, setMaxListeners } = require('node:events');

async function testOnceSignal() {
  const ee = new EventEmitter();

  const ac1 = new AbortController();
  ac1.abort();
  try {
    await once(ee, 'foo', { signal: ac1.signal });
    console.log('pre-aborted: UNEXPECTED OK');
  } catch (e) {
    console.log(
      'pre-aborted:',
      e.name,
      e.code,
      'listeners:',
      ee.listenerCount('foo'),
      ee.listenerCount('error'),
    );
  }

  const ac2 = new AbortController();
  const p2 = once(ee, 'foo', { signal: ac2.signal });
  console.log('pending listeners:', ee.listenerCount('foo'), ee.listenerCount('error'));
  setTimeout(() => ac2.abort(), 5);
  try {
    await p2;
    console.log('aborted: UNEXPECTED OK');
  } catch (e) {
    console.log(
      'aborted:',
      e.name,
      e.code,
      'listeners:',
      ee.listenerCount('foo'),
      ee.listenerCount('error'),
    );
  }

  const ac3 = new AbortController();
  const p3 = once(ee, 'foo', { signal: ac3.signal });
  ee.emit('foo', 42);
  const res = await p3;
  ac3.abort();
  console.log('resolved before abort:', JSON.stringify(res));

  try {
    await once(ee, 'foo', { signal: 123 });
  } catch (e) {
    console.log('bad signal:', e.name, e.code);
  }

  // options itself is validateObject'd: null, scalars, arrays and functions reject.
  for (const [label, opts] of [
    ['5', 5],
    ['null', null],
    ["'x'", 'x'],
    ['[]', []],
    ['function f', function f() {}],
  ]) {
    try {
      await once(ee, 'foo', opts);
      console.log('bad options', label, 'UNEXPECTED OK');
    } catch (e) {
      console.log('bad options', label + ':', e.name, e.code, e.message);
    }
  }
}

function testSetMaxListeners() {
  for (const [label, v] of [
    ['undefined', undefined],
    ['-1', -1],
    ['NaN', NaN],
    ['"5"', '5'],
    ['Infinity', Infinity],
    ['0', 0],
    ['10', 10],
  ]) {
    try {
      new EventEmitter().setMaxListeners(v);
      console.log('proto(' + label + '): OK');
    } catch (e) {
      console.log('proto(' + label + '):', e.name, e.code);
    }
    try {
      setMaxListeners(v);
      console.log('static(' + label + '): OK');
    } catch (e) {
      console.log('static(' + label + '):', e.name, e.code);
    }
  }
  setMaxListeners(10);
}

function testListenerCount() {
  const ee = new EventEmitter();
  const fnA = () => {};
  const fnB = () => {};
  ee.on('x', fnA);
  ee.once('x', fnA);
  ee.on('x', fnB);
  console.log('count all:', ee.listenerCount('x'));
  console.log('count fnA:', ee.listenerCount('x', fnA));
  console.log('count fnB:', ee.listenerCount('x', fnB));
  console.log('count missing:', ee.listenerCount('missing', fnA));
}

function testMetaEvents() {
  const ee = new EventEmitter();
  const fnA = () => {};
  const fnB = () => {};
  const log = [];
  ee.on('newListener', (ev, l) => log.push(['new', ev, l === fnA, ee.listenerCount(ev)]));
  ee.on('removeListener', (ev, l) => log.push(['rem', ev, l === fnA, ee.listenerCount(ev)]));
  ee.once('y', fnA);
  ee.emit('y');
  ee.on('z', fnA);
  ee.on('z', fnB);
  ee.removeAllListeners('z');
  console.log('meta:', JSON.stringify(log));
}

// A listener is caller-supplied, so it can carry its own call/apply or a swapped
// prototype. node invokes it with ReflectApply, which reads none of them: the real
// body runs, with the emitter as `this` and the emitted arguments, on emit for one
// listener, for several, and when a once() wrapper fires.
function testListenerInvocation() {
  const ee = new EventEmitter();
  const seen = [];
  function own(a, b) {
    seen.push('own ' + a + b + ' ' + (this === ee));
  }
  own.call = () => seen.push('own.call');
  own.apply = () => seen.push('own.apply');
  function swapped(a) {
    seen.push('swapped ' + a + ' ' + (this === ee));
  }
  Object.setPrototypeOf(swapped, {
    call: () => seen.push('proto.call'),
    apply: () => seen.push('proto.apply'),
  });
  ee.on('one', own);
  ee.emit('one', 1, 2);
  ee.on('many', own);
  ee.on('many', swapped);
  ee.emit('many', 3, 4);
  ee.once('once', own);
  ee.emit('once', 5, 6);
  ee.prependOnceListener('once2', swapped);
  ee.emit('once2', 7);
  console.log('invoke:', seen.join('; '));
}

testSetMaxListeners();
testListenerCount();
testMetaEvents();
testListenerInvocation();
testOnceSignal();
