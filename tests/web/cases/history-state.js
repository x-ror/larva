// Session history within one document: pushState/replaceState (URL resolution, the
// state's structured clone), fragment navigations through Location (replacing the
// entry while the page loads, adding one after), scrollRestoration, and traversal
// (queued, not synchronous). Lengths are printed relative to the initial one, which is
// the browser's (Chrome's recorder starts on about:blank). Traversal stays inside the
// entries this page made; the events it fires are history-events'.
const strip = (s) => String(s).split(ORIGIN).join('ORIGIN');
const L0 = history.length;
const where = () => strip(location.href) + ' len+' + (history.length - L0);

print('start ' + where() + ' state ' + history.state + ' ' + history.scrollRestoration);
const st = { a: 1, nested: [1, 2] };
history.pushState(st, 'ignored', '/p/two?q=1#h');
print('push ' + where());
print(
  'state clone ' +
    (history.state === st) +
    ' ' +
    (history.state === history.state) +
    ' ' +
    JSON.stringify(history.state),
);
print('fields ' + location.pathname + ' ' + location.search + ' ' + location.hash);
history.replaceState({ b: 2 }, '', 'three');
print('replace ' + where() + ' ' + JSON.stringify(history.state));
history.pushState(null, '');
print('push no url ' + where() + ' ' + history.state);
history.pushState(7, '', undefined);
print('push undefined url ' + where() + ' ' + history.state);
history.pushState('s', '', null);
print('push null url ' + where() + ' ' + history.state);
history.replaceState(undefined, '', '?only=query');
print('replace query ' + where() + ' ' + history.state);
history.replaceState(null, '', ORIGIN + '/p/abs');
print('replace absolute ' + where());

history.scrollRestoration = 'manual';
print('scrollRestoration ' + history.scrollRestoration);
history.scrollRestoration = 'bogus';
print('scrollRestoration bogus ' + history.scrollRestoration);
history.pushState(null, '', '#carried');
print('scrollRestoration carried ' + history.scrollRestoration + ' ' + where());
history.scrollRestoration = 'auto';

// While the page loads, a Location-object navigation replaces the entry.
location.hash = 'loading';
print('hash while loading ' + where() + ' ' + location.hash);
location.hash = '#loading';
print('same hash ' + where());
location.hash = '';
print('empty hash ' + where() + ' ' + JSON.stringify(location.hash));

const after = (ms, f) => new Promise((r) => setTimeout(() => r(f()), ms));
(async () => {
  await after(10, () => {
    // After load, each fragment navigation adds an entry, but the same URL replaces.
    location.hash = 'one';
    print('hash after load ' + where());
    location.assign('#two');
    print('assign fragment ' + where());
    location.assign('#two');
    print('assign same url ' + where());
    location.replace('#three');
    print('replace fragment ' + where());
    location.href = '#four';
    print('href fragment ' + where());
    location.hash = 'four';
    print('same hash ' + where());
    history.back();
    print('back is queued ' + where());
  });
  await after(100, () => {
    print('after back ' + where() + ' ' + history.state);
    history.go(-2);
  });
  await after(100, () => {
    print('after go(-2) ' + where() + ' ' + history.state);
    history.forward();
  });
  await after(100, () => {
    print('after forward ' + where() + ' ' + history.state);
    history.pushState('fresh', '', '/p/fresh');
    print('push drops forward entries ' + where());
    history.forward();
  });
  await after(100, () => {
    print('forward past the end ' + where() + ' ' + history.state);
  });
})();
