// matchMedia and MediaQueryList (#14): the serialization of a media query list and the
// matches of the queries whose answer does not depend on the machine's display — the
// extremes of width/height, the media types, the light/no-preference defaults. pointer
// and hover are left out: headless Chrome answers none where a desktop (and the
// profile) answers fine/hover.
function err(f) {
  try {
    f();
    return 'no throw';
  } catch (e) {
    return e.constructor.name + ': ' + e.message;
  }
}

print('missing arg ' + err(() => matchMedia()));
const queries = [
  '',
  'all',
  'screen',
  'print',
  'not print',
  'only screen',
  'speech',
  'not all',
  '(min-width: 1px)',
  '  (MIN-WIDTH:1px) , print ',
  '(max-width: 1px)',
  '(min-width: 100000px)',
  '(max-width: 100000px)',
  '(min-height: 1px)',
  '(width)',
  '(height)',
  '(min-width: 1em)',
  '(width >= 1px)',
  '(width < 1px)',
  '(1px <= width)',
  '(min-width: 1px) and (max-width: 2px)',
  '(min-width: 100000px), (min-width:1px)',
  'screen and (min-width: 1px)',
  'only screen and (min-width: 1px)',
  'not screen and (min-width: 1px)',
  '(prefers-color-scheme: light)',
  '(prefers-color-scheme: dark)',
  '(prefers-reduced-motion: no-preference)',
  '(prefers-reduced-motion: reduce)',
  '(prefers-reduced-motion)',
  '(prefers-contrast: no-preference)',
  '(forced-colors: none)',
  '(forced-colors)',
  '(scripting: enabled)',
  '(display-mode: browser)',
  '(min-resolution: 1dppx)',
  '(-webkit-min-device-pixel-ratio: 1)',
  '(color)',
  '(monochrome)',
  '(foo: bar)',
  '(foo)',
  'foo bar',
  'screen and',
  'and (min-width: 1px)',
  '(min-width: 1px',
  'null',
];
for (const q of queries) {
  const m = matchMedia(q);
  print(JSON.stringify(q) + ' -> ' + JSON.stringify(m.media) + ' ' + m.matches);
}
print('null ' + JSON.stringify(matchMedia(null).media));
print('undefined ' + JSON.stringify(matchMedia(undefined).media));

const m = matchMedia('(min-width: 1px)');
print('tag ' + Object.prototype.toString.call(m));
print('instance ' + (m instanceof MediaQueryList) + ' ' + (m instanceof EventTarget));
print('new list ' + (matchMedia('(min-width: 1px)') === m));
print('onchange ' + m.onchange);
const handler = () => {};
m.onchange = handler;
print('onchange set ' + (m.onchange === handler));
m.onchange = 5;
print('onchange 5 ' + m.onchange);
print('addListener ' + m.addListener(() => {}) + ' ' + m.addListener(null));
print('removeListener ' + m.removeListener(() => {}));
print('addListener none ' + err(() => m.addListener()));
print(
  'media getter ' +
    err(() => Object.getOwnPropertyDescriptor(MediaQueryList.prototype, 'media').get.call({})),
);
print('new ' + err(() => new MediaQueryList()));
