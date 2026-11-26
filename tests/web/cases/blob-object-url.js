// URL.createObjectURL/revokeObjectURL as a page has them: the blob: URL shape for
// this origin, distinct ids per registration, fetch() reading a registered Blob back,
// revocation, and the argument checks. Ported from
// tests/node-compat/cases/10-object-url.js, whose node:buffer.resolveObjectURL has no
// page counterpart: a page resolves an object URL with fetch().
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
async function main() {
  print('types ' + typeof URL.createObjectURL + ' ' + typeof URL.revokeObjectURL);
  const blob = new Blob(['hello world'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const prefix = 'blob:' + ORIGIN + '/';
  print(
    'shape ' +
      (url.startsWith(prefix) && new RegExp('^' + UUID + '$').test(url.slice(prefix.length))),
  );
  print('distinct ' + (URL.createObjectURL(blob) !== URL.createObjectURL(blob)));

  const back = await fetch(url);
  print(
    'fetched ' + back.status + ' ' + back.headers.get('content-type') + ' ' + (await back.text()),
  );

  const fileUrl = URL.createObjectURL(new File(['xyz'], 'note.txt', { type: 'text/plain' }));
  const fileBlob = await (await fetch(fileUrl)).blob();
  print(
    'file resolves to ' + fileBlob.constructor.name + ' ' + fileBlob.size + ' ' + fileBlob.type,
  );

  print('revoke returns ' + URL.revokeObjectURL(url));
  await fetch(url).then(
    () => print('revoked fetch resolved'),
    (e) => print('revoked fetch rejected ' + e.constructor.name),
  );

  for (const bad of [{}, 'str', 123, undefined, null]) {
    try {
      URL.createObjectURL(bad);
      print('createObjectURL(' + String(bad) + ') did not throw');
    } catch (e) {
      print('createObjectURL(' + String(bad) + ') threw ' + e.constructor.name + ' code ' + e.code);
    }
  }
  try {
    URL.revokeObjectURL();
    print('revokeObjectURL() did not throw');
  } catch (e) {
    print('revokeObjectURL() threw ' + e.constructor.name + ' code ' + e.code);
  }
  print('junk revokes ' + [URL.revokeObjectURL(123), URL.revokeObjectURL('blah')].join(','));
}
main().catch((e) => print('FAILED ' + e));
