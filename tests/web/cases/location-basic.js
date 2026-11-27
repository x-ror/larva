// The Location object under the fixture page URL (`<ORIGIN>/page/location-basic`):
// every getter, toString/valueOf/@@toPrimitive, the [LegacyUnforgeable] own members
// (non-configurable, the object still extensible) and ancestorOrigins, an empty
// DOMStringList. ORIGIN's port varies per run, so it is printed as `ORIGIN`.
const strip = (s) => String(s).split(ORIGIN).join('ORIGIN');
const host = ORIGIN.slice('http://'.length);

print('href ' + strip(location.href));
print('origin ' + strip(location.origin));
print('protocol ' + location.protocol);
print('host ' + (location.host === host));
print('hostname ' + location.hostname);
print('port ' + (location.port === host.slice(host.indexOf(':') + 1)));
print('pathname ' + location.pathname);
print('search ' + JSON.stringify(location.search));
print('hash ' + JSON.stringify(location.hash));
print('toString ' + strip(location.toString()));
print(
  'String ' + strip(String(location)) + ' ' + strip(`${location}`) + ' ' + strip(location + ''),
);
print(
  'valueOf ' +
    (location.valueOf === Object.prototype.valueOf) +
    ' ' +
    (location.valueOf() === location),
);
print('same object ' + (location === globalThis.location));
print(
  'same function ' +
    (location.toString === location.toString) +
    ' ' +
    (location.assign === location.assign),
);
print('own keys ' + Reflect.ownKeys(location).map(String).join(','));
print('prototype keys ' + Reflect.ownKeys(Location.prototype).map(String).join(','));
print('extensible ' + Object.isExtensible(location));
location.expando = 1;
print('expando ' + location.expando + ' ' + Object.keys(location).includes('expando'));
for (const name of ['href', 'toString']) {
  try {
    Object.defineProperty(location, name, { value: 1 });
    print('redefine ' + name + ' ok');
  } catch (e) {
    print('redefine ' + name + ' ' + e.constructor.name);
  }
  print('delete ' + name + ' ' + delete location[name] + ' ' + typeof location[name]);
}
(function () {
  'use strict';
  try {
    location.toString = null;
    print('strict write ok');
  } catch (e) {
    print('strict write ' + e.constructor.name);
  }
})();

const ao = location.ancestorOrigins;
print(
  'ancestorOrigins ' +
    Object.prototype.toString.call(ao) +
    ' ' +
    ao.length +
    ' ' +
    (ao === location.ancestorOrigins),
);
print('item ' + ao.item(0) + ' ' + ao.item(-1) + ' contains ' + ao.contains(ORIGIN));
print('iterate ' + [...ao].length + ' ' + (ao[Symbol.iterator] === Array.prototype.values));

try {
  new Location();
} catch (e) {
  print('new Location ' + e.constructor.name + ': ' + e.message);
}
try {
  Location();
} catch (e) {
  print('Location() ' + e.constructor.name + ': ' + e.message);
}
try {
  new DOMStringList();
} catch (e) {
  print('new DOMStringList ' + e.constructor.name + ': ' + e.message);
}
print('instanceof ' + (location instanceof Location) + ' ' + (ao instanceof DOMStringList));

// window.location is [PutForwards=href] and unforgeable: replacing it is impossible.
print(
  'global ' + JSON.stringify(Object.keys(Object.getOwnPropertyDescriptor(globalThis, 'location'))),
);
try {
  delete globalThis.location;
} catch (e) {}
print('after delete ' + typeof location + ' ' + (location instanceof Location));
