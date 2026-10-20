import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

test('server listens despite sync failures, validates tokens, and reloads renewed certificates', async () => {
	const routes = new Map();
	const intervals = [];
	const errors = [];
	const reloads = [];
	let certificateVersion = 1;
	let listening = false;
	let syncCalls = 0;
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const app = { use() {}, get() {}, post(route, handler) { routes.set(route, handler); } };
	const express = Object.assign(() => app, { json: () => () => {} });
	const server = {
		listen() { listening = true; },
		setSecureContext(options) { reloads.push(options); }
	};
	// Isolate imports and intervals so this exercises startup without opening a
	// port, reading real credentials/certificates, or calling external services.
	const stateKey = '__canvasServerTest';
	globalThis[stateKey] = {
		fs: {
			readdirSync: () => [{ name: 'bearbones.duckdns.org', isDirectory: () => true }],
			readFileSync: filename => Buffer.from(filename.endsWith('cert.key') ? 'key' : 'cert'),
			statSync: filename => ({ mtimeMs: filename.endsWith('cert.key') ? 1 : certificateVersion })
		},
		https: { createServer: () => server },
		express,
		canvas: {
			start: async () => {},
			canvasSync: async () => {
				syncCalls++;
				await gate;
				throw new Error('download failed');
			},
			getClientSync: async token => ({ token_good: token === 'valid' })
		},
		setInterval: (callback, milliseconds) => intervals.push({ callback, milliseconds }),
		console: { log() {}, warn() {}, error: (...args) => errors.push(args.join(' ')) },
		fetch: async () => new Response('OK')
	};
	const serverUrl = new URL('../server.js', import.meta.url).href;
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (context.parentURL === serverUrl) {
				const name = { fs: 'fs', https: 'https', express: 'express', './CanvasInterface.js': 'canvas' }[specifier];
				if (name) return { url: `canvas-server-mock:${name}`, shortCircuit: true };
				if (specifier === './secrets.js') return { url: 'canvas-server-mock:secrets', shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
		load(url, context, nextLoad) {
			if (url.startsWith('canvas-server-mock:')) {
				const name = url.split(':')[1];
				const source = name === 'secrets' ? 'export const DUCK_TOKEN = "test";' : name === 'canvas'
					? `export const { start, canvasSync, getClientSync } = globalThis.${stateKey}.canvas;`
					: `export default globalThis.${stateKey}.${name};`;
				return { format: 'module', source, shortCircuit: true };
			}
			const result = nextLoad(url, context);
			if (url === serverUrl) return { ...result, source:
				`const { setInterval, console, fetch } = globalThis.${stateKey};\n` + result.source };
			return result;
		}
	});
	try {
		await import(serverUrl);
		assert.equal(listening, true);
		assert.equal(syncCalls, 1);
		release();
		await new Promise(resolve => setImmediate(resolve));
		assert.match(errors[0], /Background Canvas sync failed: download failed/);
		await intervals.find(interval => interval.milliseconds === 4 * 60 * 60 * 1000).callback();
		assert.equal(errors.length, 2);
		const maintenance = intervals.find(interval => interval.milliseconds === 30 * 60 * 1000).callback;
		await maintenance();
		assert.equal(reloads.length, 0);
		certificateVersion++;
		await maintenance();
		assert.equal(reloads.length, 1);
		assert.ok(Buffer.isBuffer(reloads[0].key));
		assert.ok(Buffer.isBuffer(reloads[0].cert));
		for (const body of [undefined, {}, { token: 123 }, { token: ' ' }, { token: 'valid' }]) {
			const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
			await routes.get('/sync')({ body }, response);
			assert.equal(response.statusCode, body?.token === 'valid' ? 200 : 400);
		}
	} finally {
		release();
		hook.deregister();
		delete globalThis[stateKey];
	}
});
