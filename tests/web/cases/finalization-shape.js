// FinalizationRegistry as a page sees it without a collection (#91): Lava routes the
// cleanup through the page's own loop, and none of that may show — not in the
// constructor's source text, name, length, keys or prototype, not in subclassing or
// Reflect.construct, and not as extra frames in a misuse's stack. The cleanup itself
// needs a forced GC, which a page cannot ask for: cmd/lava/runloop_drive_test.odin.
const FR = FinalizationRegistry;
function desc(o, k) {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d ? [typeof d.value, d.writable, d.enumerable, d.configurable].join('/') : 'none';
}
print('typeof ' + typeof FR + ' name ' + FR.name + ' length ' + FR.length);
print(
  'native source ' +
    /^function FinalizationRegistry\(\) \{\s*\[native code\]\s*\}$/.test(
      Function.prototype.toString.call(FR),
    ),
);
print('own keys ' + Object.getOwnPropertyNames(FR).sort().join(','));
print('global ' + desc(globalThis, 'FinalizationRegistry'));
print('prototype ' + desc(FR, 'prototype'));
print(
  'prototype.constructor ' +
    (FR.prototype.constructor === FR) +
    ' ' +
    desc(FR.prototype, 'constructor'),
);
print('[[Prototype]] is Function.prototype ' + (Object.getPrototypeOf(FR) === Function.prototype));

const fr = new FR(() => {});
print('instance ' + (fr instanceof FR) + ' ' + (Object.getPrototypeOf(fr) === FR.prototype));
print('tag ' + Object.prototype.toString.call(fr));
class Sub extends FR {}
const sub = new Sub(() => {});
print(
  'subclass ' +
    (sub instanceof Sub) +
    ' ' +
    (Object.getPrototypeOf(sub) === Sub.prototype) +
    ' ' +
    (sub instanceof FR),
);
print(
  'subclass source names FR ' + /FinalizationRegistry/.test(String(Object.getPrototypeOf(Sub))),
);
function Other() {}
const viaReflect = Reflect.construct(FR, [() => {}], Other);
print('Reflect.construct newTarget ' + (Object.getPrototypeOf(viaReflect) === Other.prototype));
print('register ' + fr.register({}, 1) + ' unregister ' + fr.unregister({}));

// `clean`: no trace of a wrapper in the stack or message. A frame named `construct` is
// a wrapper's trap except under Reflect.construct, whose own frame JSC names so.
function misuse(label, f, viaReflect) {
  try {
    f();
    print(label + ' no throw');
  } catch (e) {
    const text = String(e.stack) + e.message;
    const wrapper = /internal\/|ReflectApply|ProxyObject|apply@|\(evaluating/.test(text);
    const trap = !viaReflect && /construct@/.test(text);
    print(label + ' ' + e.constructor.name + ' clean ' + !(wrapper || trap));
  }
}
misuse('new FR(1)', () => new FR(1));
misuse('new FR()', () => new FR());
misuse('FR(fn)', () => FR(() => {}));
misuse('Reflect.construct(FR, [1])', () => Reflect.construct(FR, [1]), true);
