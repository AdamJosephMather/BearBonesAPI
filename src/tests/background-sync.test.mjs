import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';

const directory = await mkdtemp(path.join(os.tmpdir(), 'canvas-background-test-'));
process.env.CANVAS_DB_PATH = path.join(directory, 'canvas.db');
process.env.USER_DB_PATH = path.join(directory, 'users.db');
process.env.CANVAS_BASE_URL = 'https://canvas.test/api/v1/';
process.env.OPENROUTER_API_KEY = 'test-key';
const api = await import('../CanvasInterface.js');
const { DatabaseManager } = await import('../db/node-adapter.js');
const db = new DatabaseManager(process.env.CANVAS_DB_PATH);
const json = data => new Response(JSON.stringify(data));

async function waitFor(predicate) {
	const deadline = Date.now() + 2_000;
	while (!await predicate()) {
		assert.ok(Date.now() < deadline, 'Background work did not finish');
		await delay(5);
	}
}

test('on-demand background indexing', { timeout: 10_000 }, async t => {
	const originalFetch = globalThis.fetch;
	const originalError = console.error;
	const enrollments = new Map([['first', ['1']], ['second', ['1', '2']], ['third', ['3']], ['fourth', ['4']]]);
	const runs = new Map();
	const errors = [];
	let release;
	let blocked;
	function pauseCourse(course, status = 200) {
		blocked = { course, status, gate: new Promise(resolve => { release = resolve; }) };
	}
	console.error = (...args) => errors.push(args.join(' '));
	globalThis.fetch = async (url, options) => {
		const pathname = new URL(url).pathname;
		const token = options.headers.Authorization.replace('Bearer ', '');
		assert.ok(enrollments.has(token));
		if (pathname === '/api/v1/courses') return json(enrollments.get(token).map(id => ({ id, name: 'Course ' + id })));
		const match = pathname.match(/^\/api\/v1\/courses\/(\d+)(?:\/(modules|assignments))?$/);
		assert.ok(match, 'Unexpected HTTP request: ' + url);
		const [, course, resource] = match;
		if (!resource) return json({ id: course, name: 'Course ' + course });
		if (resource === 'modules') {
			runs.set(course, (runs.get(course) ?? 0) + 1);
			if (blocked?.course === course) {
				const pause = blocked;
				blocked = undefined;
				await pause.gate;
				if (pause.status !== 200) return new Response('', { status: pause.status });
			}
		}
		return json([]);
	};
	const indexed = async course => (await db.query('SELECT course_id FROM CourseSnapshots WHERE course_id = ?', [course])).length === 1;
	try {
		await t.test('unknown courses return immediately and start indexing when idle', async () => {
			pauseCourse('1');
			const result = await api.getClientSync('first');
			assert.equal(result.started_index_of_course, true);
			assert.equal(result.courses[0].last_update, -1);
			assert.equal(runs.size, 0); // No course sync started before the response.
			await waitFor(() => runs.get('1') === 1);
		});
		await t.test('requests during a sync coalesce into one follow-up covering all registered courses', async () => {
			const responses = await Promise.all(Array.from({ length: 3 }, () => api.getClientSync('second')));
			assert.ok(responses.every(response => response.started_index_of_course));
			assert.deepEqual(responses[0].courses.map(course => course.course_id), ['1', '2']);
			assert.equal(runs.get('1'), 1);
			assert.equal(runs.has('2'), false); // The current run still owns the sync.
			release();
			await waitFor(() => indexed('2'));
			await nextTurn();
			assert.equal(runs.get('1'), 2);
			assert.equal(runs.get('2'), 1);
			assert.ok((await api.getClientSync('second')).courses.every(course => course.last_update > 0));
		});
		await t.test('known courses do not schedule another run', async () => {
			const before = [...runs];
			assert.equal((await api.getClientSync('second')).started_index_of_course, false);
			await nextTurn();
			assert.deepEqual([...runs], before);
		});
		await t.test('a queued run proceeds after the current sync fails', async () => {
			pauseCourse('1', 500);
			const running = api.canvasSync();
			await waitFor(() => runs.get('1') === 3);
			assert.equal((await api.getClientSync('third')).started_index_of_course, true);
			const rejection = assert.rejects(running, /500/);
			release();
			await rejection;
			await waitFor(() => indexed('3'));
			await nextTurn();
			assert.equal(runs.get('1'), 4);
			assert.equal(runs.get('3'), 1);
		});
		await t.test('background failures are handled and a later request can retry', async () => {
			pauseCourse('4', 500);
			assert.equal((await api.getClientSync('fourth')).started_index_of_course, true);
			await waitFor(() => runs.get('4') === 1);
			release();
			await waitFor(() => errors.length === 1);
			assert.match(errors[0], /Background Canvas sync failed.*500/);
			assert.equal(await indexed('4'), false);
			assert.equal((await api.getClientSync('fourth')).started_index_of_course, true);
			await waitFor(() => indexed('4'));
			assert.equal(runs.get('4'), 2);
		});
		await t.test('stop cancels a pending run before closing databases', async () => {
			await nextTurn();
			enrollments.set('fourth', ['5']);
			assert.equal((await api.getClientSync('fourth')).started_index_of_course, true);
			await api.stop();
			await nextTurn();
			assert.equal(runs.has('5'), false);
		});
	} finally {
		release?.();
		await api.stop();
		globalThis.fetch = originalFetch;
		console.error = originalError;
		await db.close();
		await rm(directory, { recursive: true, force: true });
	}
});
