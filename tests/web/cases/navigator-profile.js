// navigator, screen and the window's geometry. Their values are the machine's in a
// recording and the client profile's in Lava, so this prints what both must agree on:
// types, Blink's constants, and the relations a fingerprinting script checks between
// the values (appVersion is the User-Agent less `Mozilla/`, the platform is in the UA,
// the viewport fits the window, the available area fits the screen).
const n = navigator;
const ua = n.userAgent;
print(
  'userAgent ' +
    typeof ua +
    ' ' +
    ua.startsWith('Mozilla/5.0 (') +
    ' ' +
    /Chrome\/158\./.test(ua) +
    ' ' +
    / Safari\/537\.36$/.test(ua),
);
print('appVersion ' + (n.appVersion === ua.slice('Mozilla/'.length)));
print('platform ' + typeof n.platform + ' ' + ua.includes(n.platform));
for (const k of ['appCodeName', 'appName', 'product', 'productSub', 'vendor', 'vendorSub']) {
  print(k + ' ' + JSON.stringify(n[k]));
}
print('language ' + typeof n.language + ' ' + (n.languages[0] === n.language));
print(
  'languages ' +
    Array.isArray(n.languages) +
    ' ' +
    Object.isFrozen(n.languages) +
    ' ' +
    (n.languages === n.languages) +
    ' ' +
    (n.languages.length > 0) +
    ' ' +
    n.languages.every((l) => typeof l === 'string'),
);
print('onLine ' + n.onLine + ' cookieEnabled ' + n.cookieEnabled + ' webdriver ' + n.webdriver);
print('javaEnabled ' + n.javaEnabled() + ' doNotTrack ' + n.doNotTrack);
print(
  'hardwareConcurrency ' + (Number.isInteger(n.hardwareConcurrency) && n.hardwareConcurrency > 0),
);
print('deviceMemory ' + [0.25, 0.5, 1, 2, 4, 8, 16, 32].includes(n.deviceMemory));
print('maxTouchPoints ' + (Number.isInteger(n.maxTouchPoints) && n.maxTouchPoints >= 0));
print('same navigator ' + (navigator === navigator) + ' ' + (navigator instanceof Navigator));

const s = screen;
const ints = [
  'width',
  'height',
  'availWidth',
  'availHeight',
  'availLeft',
  'availTop',
  'colorDepth',
  'pixelDepth',
];
print('screen ints ' + ints.every((k) => Number.isInteger(s[k])));
print('screen positive ' + (s.width > 0 && s.height > 0 && s.availWidth > 0 && s.availHeight > 0));
print('avail fits ' + (s.availWidth <= s.width && s.availHeight <= s.height));
print('depth ' + (s.colorDepth === s.pixelDepth) + ' ' + [24, 30, 32].includes(s.colorDepth));
print('isExtended ' + s.isExtended + ' onchange ' + s.onchange);
s.onchange = () => {};
print('onchange set ' + typeof s.onchange);
s.onchange = 5;
print('onchange non-callable ' + s.onchange);
print('screen EventTarget ' + (s instanceof EventTarget) + ' ' + typeof s.addEventListener);

const g = globalThis;
const geometry = [
  'innerWidth',
  'innerHeight',
  'outerWidth',
  'outerHeight',
  'screenX',
  'screenY',
  'screenLeft',
  'screenTop',
  'scrollX',
  'scrollY',
  'pageXOffset',
  'pageYOffset',
];
print('geometry ints ' + geometry.every((k) => Number.isInteger(g[k])));
print('viewport positive ' + (innerWidth > 0 && innerHeight > 0));
print('viewport fits window ' + (innerWidth <= outerWidth && innerHeight <= outerHeight));
print(
  'aliases ' +
    (screenLeft === screenX &&
      screenTop === screenY &&
      pageXOffset === scrollX &&
      pageYOffset === scrollY),
);
print('not scrolled ' + scrollX + ' ' + scrollY);
print('devicePixelRatio ' + typeof devicePixelRatio + ' ' + (devicePixelRatio > 0));

// [Replaceable]: assigning replaces the accessor with a data property.
innerWidth = 'replaced';
print(
  'innerWidth replaced ' +
    innerWidth +
    ' ' +
    JSON.stringify(Object.getOwnPropertyDescriptor(g, 'innerWidth')),
);
screen = 5;
print('screen replaced ' + screen);
// navigator is read-only: a sloppy assignment is ignored.
navigator = 5;
print('navigator kept ' + typeof navigator + ' ' + (navigator === n));
history = 5;
print('history kept ' + typeof history);
