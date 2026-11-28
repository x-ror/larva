#!/usr/bin/env node
// Local TLS fingerprint echo (#6). A plain TCP listener on 127.0.0.1 that reads the
// first TLS record a client sends — its ClientHello — and closes the connection
// without answering, so nothing about the capture depends on a TLS stack of ours.
// It prints JA3 and JA4 for each capture and, with --record, writes Chrome's raw
// ClientHello to tests/tls/, which pkg/tls/fingerprint_test.odin compares Larva's
// own ClientHello against. No third-party fingerprint service is involved.
//
//   node scripts/record-tls-hello.mjs [--record] [--chrome=google-chrome] [--lava=bin/lava]
//
// Chrome is driven headless at https://localhost:<port>/ (the handshake then fails,
// which is expected: there is no server behind the echo); Larva by `lava fetch`.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const [k, v] = a.replace(/^--/, "").split("=");
		return [k, v ?? true];
	}),
);
const CHROME = args.chrome ?? "google-chrome";
const LAVA = args.lava ?? join(ROOT, "bin/lava");
const OUT = join(ROOT, "tests/tls/chrome-158-linux.clienthello.hex");

const isGrease = (v) => (v & 0x0f0f) === 0x0a0a && v >> 8 === (v & 0xff);
const hex4 = (v) => v.toString(16).padStart(4, "0");
const sha12 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

// parseHello reads a ClientHello record (5-byte record header included).
export function parseHello(buf) {
	let p = 5 + 4; // record header, handshake header
	const u8 = () => buf[p++];
	const u16 = () => {
		const v = buf.readUInt16BE(p);
		p += 2;
		return v;
	};
	const legacyVersion = u16();
	p += 32; // random
	const sidLen = u8();
	p += sidLen; // session id
	const ciphers = [];
	const cipherLen = u16();
	for (const end = p + cipherLen; p < end; ) ciphers.push(u16());
	const compLen = u8();
	p += compLen; // compression methods
	const exts = [];
	const bodies = new Map();
	let sni = false;
	let alpn = [];
	let sigalgs = [];
	let groups = [];
	let versions = [];
	let points = [];
	const extLen = u16();
	for (const end = p + extLen; p < end; ) {
		const type = u16();
		const len = u16();
		const body = buf.subarray(p, p + len);
		p += len;
		exts.push(type);
		bodies.set(isGrease(type) ? "grease" : hex4(type), body);
		const list16 = (off) => {
			const out = [];
			for (let i = off; i + 1 < body.length; i += 2) out.push(body.readUInt16BE(i));
			return out;
		};
		if (type === 0) sni = true;
		if (type === 16) {
			for (let i = 2; i < body.length; ) {
				const n = body[i++];
				alpn.push(body.subarray(i, i + n).toString("latin1"));
				i += n;
			}
		}
		if (type === 13) sigalgs = list16(2);
		if (type === 10) groups = list16(2);
		if (type === 43) versions = list16(1);
		if (type === 11) points = [...body.subarray(1)];
	}
	return { legacyVersion, ciphers, exts, bodies, sni, alpn, sigalgs, groups, versions, points };
}

export function ja3(h) {
	const f = (a) => a.filter((v) => !isGrease(v)).join("-");
	const s = [h.legacyVersion, f(h.ciphers), f(h.exts), f(h.groups), h.points.join("-")].join(",");
	return { ja3: createHash("md5").update(s).digest("hex"), ja3_r: s };
}

export function ja4(h) {
	const ciphers = h.ciphers.filter((v) => !isGrease(v));
	const exts = h.exts.filter((v) => !isGrease(v));
	const vers = h.versions.filter((v) => !isGrease(v));
	const v = Math.max(...(vers.length ? vers : [h.legacyVersion]));
	const ver = { 0x0304: "13", 0x0303: "12", 0x0302: "11", 0x0301: "10" }[v] ?? "00";
	const a0 = h.alpn[0] ?? "";
	const alpn = a0 ? a0[0] + a0[a0.length - 1] : "00";
	const n2 = (n) => String(Math.min(n, 99)).padStart(2, "0");
	const a = `t${ver}${h.sni ? "d" : "i"}${n2(ciphers.length)}${n2(exts.length)}${alpn}`;
	const cs = ciphers.map(hex4).sort().join(",");
	const es = exts
		.filter((e) => e !== 0 && e !== 16)
		.map(hex4)
		.sort()
		.join(",");
	// GREASE is dropped here too: Chrome now GREASEs signature_algorithms, and a random
	// value would make two captures of one client hash apart.
	const ss = h.sigalgs
		.filter((v) => !isGrease(v))
		.map(hex4)
		.join(",");
	const c = ss ? `${es}_${ss}` : es;
	return { ja4: `${a}_${sha12(cs)}_${sha12(c)}`, ja4_r: `${a}_${cs}_${c}` };
}

function capture(run) {
	return new Promise((resolve, reject) => {
		const server = createServer((sock) => {
			let buf = Buffer.alloc(0);
			sock.on("data", (d) => {
				buf = Buffer.concat([buf, d]);
				if (buf.length >= 5 && buf.length >= 5 + buf.readUInt16BE(3)) {
					sock.destroy();
					server.close();
					child.kill("SIGKILL");
					resolve(buf.subarray(0, 5 + buf.readUInt16BE(3)));
				}
			});
			sock.on("error", () => {});
		});
		let child;
		server.listen(0, "127.0.0.1", () => {
			child = run(server.address().port);
			child.on("error", reject);
		});
		setTimeout(() => {
			server.close();
			child?.kill("SIGKILL");
			reject(new Error("no ClientHello within 30 s"));
		}, 30_000).unref();
	});
}

function report(name, raw) {
	const h = parseHello(raw);
	console.log(`${name}:`);
	console.log(`  ${JSON.stringify(ja3(h))}`);
	console.log(`  ${JSON.stringify(ja4(h))}`);
	console.log(`  alpn=${h.alpn.join(",")} groups=${h.groups.map(hex4).join(",")} exts(wire order)=${h.exts.join(",")}`);
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
	const quiet = { stdio: "ignore" };
	const chrome = await capture((port) =>
		spawn(
			CHROME,
			[
				"--headless=new",
				"--no-sandbox",
				"--disable-gpu",
				"--no-first-run",
				"--no-proxy-server",
				"--user-data-dir=" + join(process.env.TMPDIR ?? "/tmp", `larva-tls-${process.pid}`),
				// A public-looking name mapped to the echo: Chrome treats `localhost` specially
				// (no ECH GREASE, for one), and a real site is what the fingerprint must match.
				`--host-resolver-rules=MAP echo.larva.test 127.0.0.1`,
				`https://echo.larva.test:${port}/`,
			],
			quiet,
		),
	);
	report("chrome", chrome);
	if (args.record) {
		writeFileSync(OUT, chrome.toString("hex") + "\n");
		console.log(`wrote ${OUT.slice(ROOT.length + 1)}`);
	}
	const lava = await capture((port) => spawn(LAVA, ["fetch", `https://localhost:${port}/`], quiet));
	report("lava", lava);
	// Extension by extension: which bodies differ (key shares, SNI and the like differ by
	// nature; a list that differs is a fingerprint difference).
	const a = parseHello(chrome).bodies;
	const b = parseHello(lava).bodies;
	for (const k of new Set([...a.keys(), ...b.keys()])) {
		const x = a.get(k);
		const y = b.get(k);
		if (!x || !y || !x.equals(y)) {
			const show = (v) => (v ? `${v.length}B ${v.subarray(0, 24).toString("hex")}` : "absent");
			console.log(`  ext ${k}: chrome ${show(x)} | lava ${show(y)}`);
		}
	}
}
