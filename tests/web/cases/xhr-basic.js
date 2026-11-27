// XMLHttpRequest over a real socket, against the suite's fixture server (ORIGIN):
// the readyState walk with every event in order, status/statusText/responseURL,
// response headers, each responseType, a redirect, a 404 and request bodies. Paths
// are printed relative to ORIGIN, never the port.
const rel = (url) => (url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) : 'foreign ' + url);

function request(method, path, setup, body) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const log = [];
    const note = (e) =>
      log.push(
        e.type +
          '@' +
          xhr.readyState +
          (e instanceof ProgressEvent
            ? '(' + e.lengthComputable + ',' + e.loaded + ',' + e.total + ')'
            : ''),
      );
    for (const t of ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout']) {
      xhr.addEventListener(t, note);
    }
    xhr.onreadystatechange = note;
    xhr.onloadend = (e) => {
      note(e);
      resolve({ xhr, log });
    };
    xhr.open(method, ORIGIN + path);
    if (setup) setup(xhr);
    xhr.send(body === undefined ? null : body);
  });
}

async function main() {
  const fresh = new XMLHttpRequest();
  print(
    'fresh ' +
      [
        fresh.readyState,
        fresh.status,
        JSON.stringify(fresh.statusText),
        JSON.stringify(fresh.responseURL),
        JSON.stringify(fresh.responseType),
        JSON.stringify(fresh.response),
        JSON.stringify(fresh.responseText),
        fresh.timeout,
        fresh.withCredentials,
        fresh.getAllResponseHeaders() === '',
        fresh.getResponseHeader('x'),
        fresh.upload instanceof XMLHttpRequestUpload,
        fresh.upload === fresh.upload,
        fresh.responseXML,
      ].join(' '),
  );
  fresh.onreadystatechange = () => print('fresh readystatechange ' + fresh.readyState);
  fresh.open('GET', ORIGIN + '/fx/text');
  print('opened ' + fresh.readyState + ' ' + fresh.status);
  fresh.open('GET', ORIGIN + '/fx/text');
  print('reopened ' + fresh.readyState);

  let r = await request('GET', '/fx/text');
  print('text events ' + r.log.join(' '));
  print(
    'text ' +
      r.xhr.status +
      ' ' +
      JSON.stringify(r.xhr.statusText) +
      ' ' +
      rel(r.xhr.responseURL) +
      ' ' +
      JSON.stringify(r.xhr.responseText) +
      ' ' +
      (r.xhr.response === r.xhr.responseText),
  );
  print('text type ' + r.xhr.getResponseHeader('Content-Type'));

  r = await request('GET', '/fx/utf8');
  print('utf8 ' + JSON.stringify(r.xhr.responseText));

  r = await request('GET', '/fx/json', (x) => (x.responseType = 'json'));
  print('json ' + JSON.stringify(r.xhr.response) + ' ' + r.xhr.responseType);
  r = await request('GET', '/fx/text', (x) => (x.responseType = 'json'));
  print('json of text ' + r.xhr.response);

  r = await request('GET', '/fx/bytes', (x) => (x.responseType = 'arraybuffer'));
  const ab = r.xhr.response;
  print(
    'arraybuffer ' +
      (ab instanceof ArrayBuffer) +
      ' ' +
      Array.from(new Uint8Array(ab)).join(',') +
      ' same ' +
      (r.xhr.response === ab),
  );
  try {
    r.xhr.responseText;
    print('responseText of arraybuffer: no throw');
  } catch (e) {
    print('responseText of arraybuffer: ' + e.name);
  }

  r = await request('GET', '/fx/bytes', (x) => (x.responseType = 'blob'));
  const blob = r.xhr.response;
  print(
    'blob ' +
      (blob instanceof Blob) +
      ' ' +
      blob.size +
      ' ' +
      JSON.stringify(blob.type) +
      ' ' +
      Array.from(new Uint8Array(await blob.arrayBuffer())).join(','),
  );

  r = await request('GET', '/fx/text', (x) => (x.responseType = 'text'));
  print('text type text ' + JSON.stringify(r.xhr.response));

  r = await request('GET', '/fx/text', (x) => x.overrideMimeType('application/json'));
  print('override ' + JSON.stringify(r.xhr.responseText));

  r = await request('GET', '/fx/redirect');
  print('redirect ' + r.xhr.status + ' ' + rel(r.xhr.responseURL) + ' ' + r.xhr.responseText);

  r = await request('GET', '/fx/missing');
  print('missing events ' + r.log.join(' '));
  print(
    'missing ' + r.xhr.status + ' ' + JSON.stringify(r.xhr.statusText) + ' ' + r.xhr.responseText,
  );

  r = await request('HEAD', '/fx/text');
  print('head ' + r.xhr.status + ' ' + JSON.stringify(r.xhr.responseText) + ' ' + r.log.join(' '));

  r = await request('GET', '/fx/xhr-headers');
  print('all headers ' + JSON.stringify(r.xhr.getAllResponseHeaders()));
  print(
    'header x-b ' +
      r.xhr.getResponseHeader('x-b') +
      ' X-A ' +
      r.xhr.getResponseHeader('X-A') +
      ' set-cookie ' +
      r.xhr.getResponseHeader('set-cookie') +
      ' none ' +
      r.xhr.getResponseHeader('x-none'),
  );

  const post = (x) => {
    x.setRequestHeader('X-Test', 'yes');
    x.setRequestHeader('X-Multi', 'a');
    x.setRequestHeader('x-multi', 'b');
    for (const n of ['Cookie', 'DNT', 'Keep-Alive', 'Proxy-X', 'Sec-X', 'Via', 'Expect']) {
      x.setRequestHeader(n, 'v');
    }
  };
  r = await request('POST', '/fx/xhr-echo', post, 'café');
  print('post events ' + r.log.join(' '));
  print('post ' + r.xhr.responseText);

  const typed = (x) => x.setRequestHeader('Content-Type', 'application/x-test');
  r = await request('PUT', '/fx/xhr-echo', typed, new Uint8Array([104, 105]));
  print('put bytes ' + r.xhr.responseText);

  r = await request('POST', '/fx/xhr-echo', null, new Uint8Array([104, 105]).buffer);
  print('post arraybuffer ' + r.xhr.responseText);

  r = await request('POST', '/fx/xhr-echo', null, new Blob(['blob body'], { type: 'text/x-blob' }));
  print('post blob ' + r.xhr.responseText);

  r = await request('POST', '/fx/xhr-echo', null, new URLSearchParams('a=1&b=2'));
  print('post params ' + r.xhr.responseText);

  r = await request('POST', '/fx/xhr-echo', null, { toString: () => 'stringified' });
  print('post object ' + r.xhr.responseText);

  r = await request('POST', '/fx/xhr-echo', null);
  print('post null ' + r.xhr.responseText);

  r = await request('GET', '/fx/xhr-echo', null, 'dropped');
  print('get with body ' + r.xhr.responseText);
}
main().catch((e) => print('FAILED ' + e));
