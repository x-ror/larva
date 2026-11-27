// EventTarget, Event and CustomEvent as a page uses them without a DOM: construction
// and its defaults, the listener list (order, duplicates, capture, once, passive,
// signal, handleEvent objects, changes during a dispatch), dispatch's state (phase,
// targets, composedPath, cancelation, the stop flags, the legacy accessors), and the
// errors Chrome throws, with its WebIDL text. A listener that throws is a page error
// the recorder refuses, so none here does.
function show(label, f) {
  try {
    const r = f();
    print(label + ': ' + (r === undefined ? 'no throw' : String(r)));
  } catch (e) {
    print(
      label +
        ': ' +
        e.constructor.name +
        ' ' +
        e.name +
        ' ' +
        JSON.stringify(e.message) +
        ' own code ' +
        Object.prototype.hasOwnProperty.call(e, 'code'),
    );
  }
}
const log = [];
const flush = (label) => {
  print(label + ' [' + log.join(',') + ']');
  log.length = 0;
};

// Construction and defaults.
const e0 = new Event('ping');
print(
  'defaults ' +
    [
      e0.type,
      e0.bubbles,
      e0.cancelable,
      e0.composed,
      e0.defaultPrevented,
      e0.target,
      e0.currentTarget,
      e0.srcElement,
      e0.eventPhase,
      e0.isTrusted,
      e0.returnValue,
      e0.cancelBubble,
      typeof e0.timeStamp,
      e0.timeStamp >= 0,
      e0.composedPath().length,
    ].join(' '),
);
print('own keys ' + JSON.stringify(Reflect.ownKeys(e0)));
const trusted = Object.getOwnPropertyDescriptor(e0, 'isTrusted');
print(
  'isTrusted ' +
    (trusted && typeof trusted.get) +
    ' ' +
    (trusted && trusted.enumerable) +
    ' ' +
    (trusted && trusted.configurable) +
    ' shared ' +
    (trusted && trusted.get === Object.getOwnPropertyDescriptor(new Event('x'), 'isTrusted').get),
);
const e1 = new Event(42, { bubbles: 1, cancelable: 'yes', composed: {} });
print('init ' + [e1.type, e1.bubbles, e1.cancelable, e1.composed].join(' '));
print('undefined type ' + new Event(undefined).type);
print(
  'phases ' + [Event.NONE, Event.CAPTURING_PHASE, Event.AT_TARGET, Event.BUBBLING_PHASE].join(' '),
);
print('proto phase ' + e0.AT_TARGET);
const ce = new CustomEvent('c', { detail: { n: 1 } });
print('custom ' + ce.detail.n + ' ' + new CustomEvent('c').detail + ' ' + (ce instanceof Event));
print(
  'tags ' + [e0, ce, new EventTarget()].map((o) => Object.prototype.toString.call(o)).join(' '),
);

// Dictionary members are read in lexicographic order, each once.
const order = [];
const spy = (names) =>
  new Proxy(
    {},
    {
      get(t, k) {
        if (typeof k === 'string') order.push(k);
        return undefined;
      },
    },
  );
new Event('x', spy());
print('Event dict ' + order.join(','));
order.length = 0;
new CustomEvent('x', spy());
print('CustomEvent dict ' + order.join(','));
order.length = 0;
const t0 = new EventTarget();
t0.addEventListener('x', () => {}, spy());
print('add dict ' + order.join(','));
order.length = 0;
t0.removeEventListener('x', () => {}, spy());
print('remove dict ' + order.join(','));

// Listener order, duplicates, capture, handleEvent, `this`, phase and targets.
const t = new EventTarget();
const a = function (ev) {
  log.push(
    'a:' +
      (this === t) +
      ':' +
      ev.eventPhase +
      ':' +
      (ev.target === t) +
      ':' +
      (ev.currentTarget === t),
  );
  log.push('path:' + ev.composedPath().length + ':' + (ev.composedPath()[0] === t));
};
const b = () => log.push('b');
const obj = {
  handleEvent(ev) {
    log.push('obj:' + (this === obj));
  },
};
t.addEventListener('go', a);
t.addEventListener('go', a);
t.addEventListener('go', b, true);
t.addEventListener('go', b, false);
t.addEventListener('go', obj);
t.addEventListener('go', null);
t.addEventListener('other', b);
const go = new Event('go');
print('dispatch returned ' + t.dispatchEvent(go));
flush('order');
print(
  'after ' +
    [
      go.eventPhase,
      go.target === t,
      go.currentTarget,
      go.composedPath().length,
      go.srcElement === t,
    ].join(' '),
);
t.removeEventListener('go', b);
t.dispatchEvent(new Event('go'));
flush('removed bubble b');
t.removeEventListener('go', b, { capture: true });
t.removeEventListener('go', a);
t.removeEventListener('go', obj);
t.dispatchEvent(new Event('go'));
flush('all removed');
print('re-dispatch ' + t.dispatchEvent(go));

// handleEvent is read at dispatch, not at add.
const late = {};
t.addEventListener('late', late);
late.handleEvent = () => log.push('late handleEvent');
t.dispatchEvent(new Event('late'));
flush('late');

// once, passive and signal.
const t2 = new EventTarget();
t2.addEventListener('o', () => log.push('once'), { once: true });
t2.addEventListener('o', () => log.push('always'));
t2.dispatchEvent(new Event('o'));
t2.dispatchEvent(new Event('o'));
flush('once');
t2.addEventListener(
  'p',
  (ev) => {
    ev.preventDefault();
    log.push('passive ' + ev.defaultPrevented);
  },
  { passive: true },
);
print('passive dispatch ' + t2.dispatchEvent(new Event('p', { cancelable: true })));
flush('passive');
const ctl = new AbortController();
t2.addEventListener('s', () => log.push('signalled'), { signal: ctl.signal });
t2.dispatchEvent(new Event('s'));
ctl.abort();
t2.dispatchEvent(new Event('s'));
t2.addEventListener('s', () => log.push('pre-aborted'), { signal: AbortSignal.abort() });
t2.dispatchEvent(new Event('s'));
flush('signal');

// Changes to the list during a dispatch.
const t3 = new EventTarget();
const r2 = () => log.push('r2');
t3.addEventListener('m', () => {
  log.push('r1');
  t3.removeEventListener('m', r2);
  t3.addEventListener('m', () => log.push('added'));
});
t3.addEventListener('m', r2);
t3.dispatchEvent(new Event('m'));
flush('mutate first');
t3.dispatchEvent(new Event('m'));
flush('mutate second');

// Cancelation and the stop flags.
const t4 = new EventTarget();
t4.addEventListener('c', (ev) => {
  ev.preventDefault();
  log.push('prevented ' + ev.defaultPrevented + ' ' + ev.returnValue);
});
print('cancelable ' + t4.dispatchEvent(new Event('c', { cancelable: true })));
print('not cancelable ' + t4.dispatchEvent(new Event('c')));
flush('cancel');
const rv = new Event('r', { cancelable: true });
rv.returnValue = false;
print('returnValue=false ' + rv.defaultPrevented + ' ' + rv.returnValue);
rv.returnValue = true;
print('returnValue=true ' + rv.defaultPrevented);
t4.addEventListener('s', (ev) => {
  log.push('s1');
  ev.stopImmediatePropagation();
  log.push('cancelBubble ' + ev.cancelBubble);
});
t4.addEventListener('s', () => log.push('s2'));
const se = new Event('s');
t4.dispatchEvent(se);
flush('stopImmediate');
print('cancelBubble after ' + se.cancelBubble);
t4.addEventListener('b', (ev) => {
  ev.stopPropagation();
  log.push('b1');
});
t4.addEventListener('b', () => log.push('b2'));
t4.dispatchEvent(new Event('b'));
flush('stopPropagation');
const cb = new Event('b');
cb.cancelBubble = true;
print('preset cancelBubble ' + cb.cancelBubble);
t4.dispatchEvent(cb);
flush('preset cancelBubble');
cb.cancelBubble = false;
print('cancelBubble=false ' + cb.cancelBubble);

// initEvent and the legacy CustomEvent init.
const ie = new Event('first');
ie.initEvent('second', true, true);
print('initEvent ' + ie.type + ' ' + ie.bubbles + ' ' + ie.cancelable);
const ic = new CustomEvent('c');
ic.initCustomEvent('d', false, true, 'det');
print('initCustomEvent ' + ic.type + ' ' + ic.cancelable + ' ' + ic.detail);
t4.addEventListener('during', (ev) => {
  ev.initEvent('changed');
  log.push('during ' + ev.type);
});
t4.dispatchEvent(new Event('during'));
flush('initEvent during dispatch');

// Subclassing.
class Emitter extends EventTarget {
  constructor() {
    super();
    this.own = 1;
  }
}
class MyEvent extends Event {
  constructor(type) {
    super(type, { cancelable: true });
    this.extra = 'x';
  }
}
const em = new Emitter();
em.addEventListener('my', (ev) =>
  log.push(ev.extra + ' ' + (ev instanceof MyEvent) + ' ' + ev.cancelable),
);
em.dispatchEvent(new MyEvent('my'));
flush('subclass');

// AbortSignal is an EventTarget: its handler sits in listener order, and a page's
// own abort Event fires the listeners without aborting it.
const ac = new AbortController();
print('signal is EventTarget ' + (ac.signal instanceof EventTarget));
print('AbortSignal proto ' + (Object.getPrototypeOf(AbortSignal) === EventTarget));
ac.signal.addEventListener('abort', (ev) =>
  log.push('listener ' + ev.type + ' ' + (ev instanceof Event) + ' ' + ev.isTrusted),
);
ac.signal.onabort = (ev) => log.push('onabort ' + (ev.currentTarget === ac.signal));
ac.signal.addEventListener('abort', () => log.push('listener 2'));
print('fake abort ' + ac.signal.dispatchEvent(new Event('abort')) + ' ' + ac.signal.aborted);
flush('fake abort');
ac.abort();
flush('real abort');
ac.signal.onabort = 5;
print('onabort non-function ' + ac.signal.onabort);

// Errors.
show('Event()', () => Event('x'));
show('new Event()', () => new Event());
show('new Event(symbol)', () => new Event(Symbol('s')));
show('new Event(x, 1)', () => new Event('x', 1));
show('EventTarget()', () => EventTarget());
show('CustomEvent()', () => CustomEvent('x'));
show('new CustomEvent()', () => new CustomEvent());
show('new CustomEvent(x, 1)', () => new CustomEvent('x', 1));
show('initCustomEvent on Event', () =>
  CustomEvent.prototype.initCustomEvent.call(new Event('x'), 'y'),
);
show('addEventListener()', () => t.addEventListener('x'));
show('addEventListener(x, 1)', () => t.addEventListener('x', 1));
show('addEventListener(x, f, 1)', () => t.addEventListener('x', b, 1));
show('removeEventListener()', () => t.removeEventListener('x'));
show('removeEventListener(x, 1)', () => t.removeEventListener('x', 1));
show('addEventListener signal 1', () => t.addEventListener('x', b, { signal: 1 }));
show('addEventListener signal null', () => t.addEventListener('x', b, { signal: null }));
show('dispatchEvent()', () => t.dispatchEvent());
show('dispatchEvent({})', () => t.dispatchEvent({ type: 'x' }));
show('addEventListener on {}', () => EventTarget.prototype.addEventListener.call({}, 'x', b));
show('dispatchEvent on {}', () => EventTarget.prototype.dispatchEvent.call({}, new Event('x')));
show('type on {}', () => Object.getOwnPropertyDescriptor(Event.prototype, 'type').get.call({}));
show('detail on Event', () =>
  Object.getOwnPropertyDescriptor(CustomEvent.prototype, 'detail').get.call(e0),
);
show('initEvent()', () => e0.initEvent());
const nested = new EventTarget();
nested.addEventListener('n', (ev) => {
  show('re-dispatch while dispatching', () => nested.dispatchEvent(ev));
  show('dispatch on another target', () => new EventTarget().dispatchEvent(ev));
});
nested.dispatchEvent(new Event('n'));
