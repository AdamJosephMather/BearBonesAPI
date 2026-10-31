import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const directory = await mkdtemp(path.join(os.tmpdir(), 'canvas-parallel-test-'));
process.env.CANVAS_DB_PATH = path.join(directory, 'canvas.db');
process.env.USER_DB_PATH = path.join(directory, 'users.db');
process.env.CANVAS_BASE_URL = 'https://canvas.test/api/v1/';
process.env.OPENROUTER_API_KEY = 'test-key';
const api = await import('../CanvasInterface.js');
const { DatabaseManager } = await import('../db/node-adapter.js');
const db = new DatabaseManager(process.env.CANVAS_DB_PATH);
const users = new DatabaseManager(process.env.USER_DB_PATH);
const json = data => new Response(JSON.stringify(data));
const deferred = () => {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
};
async function waitFor(predicate) {
	const deadline = Date.now() + 3000;
	while (!await predicate()) {
		assert.ok(Date.now() < deadline, 'Expected progress while another request was blocked');
		await delay(5);
	}
}

test('Canvas credentials serialize bodies, allow different keys, and recover from failures', async () => {
	const originalFetch = globalThis.fetch;
	const bodyGate = deferred();
	const started = [];
	globalThis.fetch = async (url, options) => {
		const pathname = new URL(url).pathname;
		started.push([pathname, options.headers.Authorization]);
		if (pathname.endsWith('/blocked')) return {
			ok: true, headers: new Headers(),
			json: async () => { await bodyGate.promise; return []; }
		};
		if (pathname.endsWith('/error')) throw new Error('network failed');
		return json([]);
	};
	let pending = [];
	try {
		pending = [api.fetchData('blocked', 'one'), api.fetchData('queued', 'one'), api.fetchData('independent', 'two')];
		await waitFor(() => started.length === 2);
		assert.deepEqual(started.map(([url]) => url), ['/api/v1/blocked', '/api/v1/independent']);
		bodyGate.resolve();
		assert.ok((await Promise.all(pending)).every(([, error]) => error === null));
		const [failure, success] = await Promise.all([api.fetchData('error', 'one'), api.fetchData('retry', 'one')]);
		assert.match(failure[1], /network failed/);
		assert.equal(success[1], null);
	} finally {
		bodyGate.resolve();
		await Promise.allSettled(pending);
		globalThis.fetch = originalFetch;
	}
});

test('AI overlaps across courses; completed snapshots survive a later course failure and retry', { timeout: 10000 }, async () => {
	const originalFetch = globalThis.fetch;
	const gates = new Map(['1', '2', '3'].map(id => [id, deferred()]));
	const modelStarts = [];
	const requestsByKey = new Map();
	let activeModels = 0, peakModels = 0, failing = true, running, version = 1;
	globalThis.fetch = async (url, options) => {
		url = new URL(url);
		if (url.hostname === 'openrouter.ai') {
			const prompt = JSON.parse(options.body).messages[0].content;
			const id = prompt.match(/Course: Course (\d+)/)[1];
			modelStarts.push(id);
			peakModels = Math.max(peakModels, ++activeModels);
			await gates.get(id).promise;
			activeModels--;
			if (failing && id === '2') return new Response('', { status: 500 });
			return json({ choices: [{ message: { content: JSON.stringify({
				new_events: [{ title: `Deadline ${id}`, description: 'Details', dates: [
					{ title: 'Due', date: '15/10/2026', time: '14:00', show: true }
				] }], additions: []
			}) } }] });
		}
		const token = options.headers.Authorization;
		assert.equal(requestsByKey.get(token) ?? 0, 0, 'Same credential used concurrently');
		requestsByKey.set(token, 1);
		// Keep the credential in use until json() consumes the body.
		const match = url.pathname.match(/^\/api\/v1\/courses\/(\d+)(?:\/(modules|assignments)(?:\/(\d+))?)?$/);
		assert.ok(match, 'Unexpected request: ' + url);
		const [, id, resource, assignmentId] = match;
		let data;
		if (!resource) data = { id, name: `Course ${id}` };
		else if (resource === 'modules') data = [{ id: `${id}0`, name: 'Module', items_url: `/api/v1/courses/${id}/assignments/0` }];
		else if (assignmentId === '0') data = [{ id: `${id}00`, type: 'Assignment', content_id: `${id}01` }];
		else if (assignmentId) data = { id: assignmentId, name: 'Assignment', description: `Deadline ${version}`, due_at: '2026-10-15T20:00:00Z' };
		else data = []; // Exercise the individual assignment fallback per course.
		return { ok: true, headers: new Headers(), json: async () => {
			await delay(1);
			requestsByKey.set(token, 0);
			return data;
		} };
	};
	const snapshots = () => db.query('SELECT course_id, payload FROM CourseSnapshots ORDER BY course_id');
	try {
		await api.start();
		for (const [course, token] of [['1', 'shared'], ['2', 'shared'], ['3', 'separate']]) {
			await users.run('INSERT INTO TokenForCourses (course, token) VALUES (?, ?)', [course, token]);
		}
		let settled = false;
		running = api.canvasSync();
		const failure = assert.rejects(running, /500/);
		running.then(() => { settled = true; }, () => { settled = true; });
		await waitFor(() => modelStarts.length === 3);
		assert.equal(peakModels, 3);
		gates.get('1').resolve();
		await waitFor(async () => (await snapshots()).length === 1);
		assert.deepEqual((await snapshots()).map(row => row.course_id), ['1']);
		const payload = JSON.parse((await snapshots())[0].payload);
		assert.equal(payload.assignments[0].module_id, '10');
		assert.equal(payload.events[0].title, 'Deadline 1');
		gates.get('2').resolve();
		await delay(20);
		assert.equal(settled, false, 'Failure must drain other course workers before closing SQLite');
		gates.get('3').resolve();
		await failure;
		assert.deepEqual((await snapshots()).map(row => row.course_id), ['1', '3']);
		failing = false;
		await api.canvasSync();
		assert.deepEqual(modelStarts.slice(3), ['2'], 'Retry must reuse completed AI work');
		assert.deepEqual((await snapshots()).map(row => row.course_id), ['1', '2', '3']);
		assert.equal((await db.query('SELECT * FROM SavedEvents')).length, 3);
		// All responses are now immediately available: exercise simultaneous saves,
		// source replacement, orphan cleanup, and checkpoints on the shared connection.
		version++;
		await api.canvasSync();
		assert.equal(modelStarts.length, 7);
		assert.equal((await db.query('SELECT * FROM SavedEvents')).length, 3);
		assert.equal((await db.query('SELECT * FROM DateFacts')).length, 3);
		assert.ok((await snapshots()).every(row => JSON.parse(row.payload).events.length === 1));
	} finally {
		for (const gate of gates.values()) gate.resolve();
		await running?.catch(() => {});
		await api.stop();
		await db.close();
		await users.close();
		globalThis.fetch = originalFetch;
		await rm(directory, { recursive: true, force: true });
	}
});
