// hashchange and popstate at the window: which navigations fire them, when (queued as a
// task after the one that navigated, or inside the traversal's task), in what order,
// and with what oldURL/newURL/state; the onhashchange/onpopstate handler attributes;
// and pushState/replaceState, which fire nothing. Traversal stays inside the entries
// this page made (Chrome's recorder starts on about:blank).
const strip = (s) => String(s).split(ORIGIN).join('ORIGIN');
const hashOf = (u) => {
  const s = String(u);
  const at = s.indexOf('#');
  return at === -1 ? '(none)' : s.slice(at);
};
const log = [];
const note = (s) => log.push(s);
const flush = (tag) => {
  print(tag + ': ' + (log.length ? log.join(' | ') : '-'));
  log.length = 0;
};

const desc = (name) => {
  const d = Object.getOwnPropertyDescriptor(globalThis, name);
  return d
    ? name +
        ' own get=' +
        typeof d.get +
        ' set=' +
        typeof d.set +
        ' enum=' +
        d.enumerable +
        ' conf=' +
        d.configurable
    : name + ' not own';
};
print(desc('onhashchange'));
print(desc('onpopstate'));
print('initial ' + onhashchange + ' ' + onpopstate);
print('global is EventTarget ' + (globalThis instanceof EventTarget));

addEventListener('hashchange', (e) => {
  note(
    'hashchange ' +
      hashOf(e.oldURL) +
      '->' +
      hashOf(e.newURL) +
      ' trusted=' +
      e.isTrusted +
      ' bubbles=' +
      e.bubbles +
      ' cancelable=' +
      e.cancelable +
      ' target=' +
      (e.target === globalThis) +
      ' ' +
      (e instanceof HashChangeEvent) +
      ' ' +
      Object.prototype.toString.call(e) +
      ' sameDoc=' +
      strip(e.newURL).startsWith('ORIGIN/') +
      ' now=' +
      location.hash,
  );
});
addEventListener('popstate', (e) => {
  note(
    'popstate state=' +
      JSON.stringify(e.state) +
      ' same=' +
      (e.state === history.state) +
      ' visual=' +
      e.hasUAVisualTransition +
      ' trusted=' +
      e.isTrusted +
      ' bubbles=' +
      e.bubbles +
      ' cancelable=' +
      e.cancelable +
      ' ' +
      (e instanceof PopStateEvent) +
      ' ' +
      Object.prototype.toString.call(e) +
      ' at=' +
      location.hash,
  );
});

// The handler attributes: a non-object is null; `this` is the window; the handler's
// listener keeps the place it took when first set.
onhashchange = 5;
print('onhashchange non-object ' + onhashchange);
onhashchange = function (e) {
  note('onhashchange this=' + (this === globalThis) + ' ' + e.type);
};
print('onhashchange set ' + typeof onhashchange);
onpopstate = function (e) {
  note('onpopstate ' + JSON.stringify(e.state));
};

// While the page loads: the navigation replaces the entry, and hashchange still fires,
// after this task.
location.hash = 'a';
note('sync after hash=a');
location.hash = 'b';
note('sync after hash=b');
history.pushState({ p: 1 }, '', '#pushed');
history.replaceState({ p: 2 }, '', '#replaced');
note('pushState and replaceState are silent');
flush('script');

const after = (ms, f) => new Promise((r) => setTimeout(() => r(f()), ms));
(async () => {
  await after(10, () => {
    flush('first timer');
    location.hash = 'one';
    note('sync');
  });
  await after(10, () => {
    flush('hash=one');
    location.assign('#two');
    location.assign('#two');
  });
  await after(10, () => {
    flush('assign #two twice');
    location.replace('#three');
  });
  await after(10, () => {
    flush('replace #three');
    location.href = '#four';
    location.hash = 'four';
  });
  await after(10, () => {
    flush('href #four then same hash');
    location.hash = '';
  });
  await after(10, () => {
    flush('empty hash');
    history.pushState({ s: 'x' }, '', '#x');
    history.pushState({ s: 'y' }, '', '#y');
    history.pushState({ s: 'y2' }, '');
  });
  await after(10, () => {
    flush('pushState x, y, y2');
    history.back();
    note('back queued');
  });
  await after(100, () => {
    flush('back (same fragment)');
    history.back();
  });
  await after(100, () => {
    flush('back (#y to #x)');
    history.go(-2);
  });
  await after(100, () => {
    flush('go(-2)');
    history.forward();
  });
  await after(100, () => {
    flush('forward');
    onhashchange = null;
    onpopstate = {};
    print('handlers cleared ' + onhashchange + ' ' + typeof onpopstate);
    history.go(2);
  });
  await after(100, () => {
    flush('go(2) without handlers');
    location.hash = 'timer-race';
    setTimeout(() => note('timeout queued after the navigation'), 0);
  });
  await after(100, () => {
    flush('task order');
    print('done ' + hashOf(location.href));
  });
})();
