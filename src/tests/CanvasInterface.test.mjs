import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.CANVAS_TOKEN = 'test-token';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.CANVAS_BASE_URL = 'https://canvas.test/api/v1/';
const api = await import('../CanvasInterface.js');
const db = await import('../db/node-adapter.js');
const json = (data, headers = {}) => new Response(JSON.stringify(data), { headers });
const modelResult = (title = 'Deadline') => ({ choices: [{ message: { content: JSON.stringify({
	new_events: [{ title, description: 'Details', dates: [{ title: 'Due', date: '15/10/2026', time: '14:00' }] }],
	additions: []
}) } }] });

test('Canvas sync regression coverage with mocked HTTP and real SQLite', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'canvas-interface-test-'));
	process.env.CANVAS_DB_PATH = path.join(directory, 'sync.db');
	const originalFetch = globalThis.fetch;
	let version = 1, courseName = 'Course', modelCalls = 0, failModel = false, forbidden = false, empty = false;
	let fallback = false, omitPage = false;
	const assignment = id => ({
		id, name: 'Assignment ' + id, updated_at: 'unchanged',
		due_at: version === 1 ? '2026-10-15T20:00:00Z' : '2026-10-16T20:00:00Z',
		description: 'Assignment', allowed_attempts: 2, points_possible: 5,
		has_submitted_submissions: true, locked_for_user: false,
		graded_submissions_exist: false, is_quiz_assignment: false
	});
	globalThis.fetch = async (url, options) => {
		url = new URL(url);
		if (url.hostname === 'openrouter.ai') {
			modelCalls++;
			assert.equal(options.method, 'POST');
			const body = JSON.parse(options.body);
			assert.equal(typeof body.messages[0].content, 'string');
			assert.equal(options.headers.Authorization, 'Bearer test-key');
			if (failModel) return json({ choices: [{ message: { content: 'bad JSON' } }] });
			return json(modelResult());
		}
		if (url.hostname === 'download.test') return new Response('Deadline is October 15.');
		assert.equal(options.headers.Authorization, 'Bearer test-token');
		switch (url.pathname) {
			case '/api/v1/courses':
				return json(empty ? [] : [{ id: 1, name: courseName, uuid: 'uuid' }]);
			case '/api/v1/courses/1/modules':
				return json([{ id: 10, name: 'Module ' + version, items_url: 'https://canvas.test/items' }]);
			case '/items':
				return json([
					...(!omitPage ? [{ id: 101, type: 'Page', url: 'https://canvas.test/page' }] : []),
					{ id: 102, type: 'Quiz', content_id: 20, url: 'https://canvas.test/quiz' },
					{ id: 103, type: 'Discussion', content_id: 30, url: 'https://canvas.test/discussion' },
					{ id: 104, type: 'File', content_id: 40, url: 'https://canvas.test/file' },
					{ id: 105, type: 'ExternalUrl', title: 'External ' + version, html_url: 'https://external.test/' },
					{ id: 106, type: 'Assignment', content_id: 50 },
					...(fallback ? [{ id: 107, type: 'Assignment', content_id: 52 }] : [])
				]);
			case '/page':
				if (forbidden) return new Response('', { status: 403 });
				return json({ page_id: 11, title: 'Page', body: 'Body ' + version, updated_at: String(version) });
			case '/quiz':
				return json({ id: 20, title: 'Quiz', description: 'Quiz ' + version, version_number: version, published: true, locked_for_user: false });
			case '/discussion':
				return json({ id: 30, title: 'Discussion', message: 'Message ' + version, published: true, locked_for_user: false });
			case '/file':
				return json({ id: 40, display_name: 'File', filename: 'file.txt', updated_at: String(version), url: 'https://download.test/file', hidden_for_user: false, locked_for_user: false });
			case '/api/v1/courses/1/assignments':
				return url.searchParams.has('page') ? json([assignment(51)]) :
					json([assignment(50)], { link: '<https://canvas.test/api/v1/courses/1/assignments?page=2>; rel="next"' });
			case '/api/v1/courses/1/assignments/52':
				return json(assignment(52));
			default: throw new Error('Unexpected mocked URL: ' + url);
		}
	};
	try {
		await t.test('initial sync creates valid tables and all source types; pagination includes the second assignment', async () => {
			await api.main();
			assert.equal(modelCalls, 6);
			assert.equal((await db.query('SELECT * FROM Assignments')).length, 2);
			assert.equal((await db.query('SELECT * FROM SavedEvents')).length, 6);
			const facts = await db.query('SELECT from_type, from_id FROM CreationFacts');
			assert.ok(facts.some(row => row.from_type === 'page' && row.from_id === '11'));
			assert.ok(facts.some(row => row.from_type === 'assignment' && row.from_id === '50'));
			assert.ok(facts.some(row => row.from_type === 'quiz' && row.from_id === '20'));
			assert.equal((await db.query('SELECT has_submitted_submissions FROM Assignments LIMIT 1'))[0].has_submitted_submissions, 1);
			await db.close();
		});
		await t.test('repeated sync is idempotent and course/module metadata is updated', async () => {
			courseName = 'Renamed';
			await api.main();
			assert.equal(modelCalls, 6);
			assert.equal((await db.query('SELECT name FROM Courses'))[0].name, 'Renamed');
			assert.equal((await db.query('SELECT * FROM DateFacts')).length, 6);
			await db.close();
		});
		await t.test('source edits re-extract quizzes, discussions, assignments, files and pages', async () => {
			version = 2;
			await api.main();
			assert.equal(modelCalls, 12);
			assert.equal((await db.query('SELECT * FROM SavedEvents')).length, 6);
			assert.equal((await db.query('SELECT title FROM Externals'))[0].title, 'External 2');
			assert.equal((await db.query('SELECT name FROM Modules'))[0].name, 'Module 2');
			await db.close();
		});
		await t.test('invalid model response rolls back replacement and leaves prior source/facts intact', async () => {
			version = 3; failModel = true;
			await assert.rejects(api.main(), /Failed to save AI response/);
			assert.equal((await db.query('SELECT body FROM Pages'))[0].body, 'Body 2');
			assert.equal((await db.query('SELECT * FROM SavedEvents')).length, 6);
			await db.close();
			version = 2; failModel = false;
		});
		await t.test('403 aborts cleanup and retains inaccessible records', async () => {
			forbidden = true;
			await assert.rejects(api.main(), /403/);
			assert.equal((await db.query('SELECT * FROM Pages')).length, 1);
			await db.close(); forbidden = false;
		});
		await t.test('individual assignment fallback succeeds and returns a success result', async () => {
			fallback = true;
			await api.main();
			assert.ok((await db.query('SELECT * FROM Assignments')).some(row => row.id === '52'));
			await db.close();
		});
		await t.test('removed sources delete associated facts and orphan events', async () => {
			omitPage = true;
			await api.main();
			assert.equal((await db.query('SELECT * FROM Pages')).length, 0);
			assert.equal((await db.query("SELECT * FROM CreationFacts WHERE from_type = 'page'")).length, 0);
			assert.equal((await db.query('SELECT * FROM SavedEvents')).length, 6);
			await db.close();
		});
		await t.test('AI payload validation rejects invalid dates and cross-course event references before mutation', async () => {
			const initial = (await db.query('SELECT * FROM SavedEvents')).length;
			const response = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
			const error = await api.updateSavedEvents(response({ new_events: [{
				title: 'Invalid', description: 'x', dates: [{ title: 'Due', date: '31/02/2026', time: '14:00' }]
			}] }), 'page', '1', '1', '10');
			assert.match(error, /calendar date/);
			const event = (await db.query('SELECT id FROM SavedEvents LIMIT 1'))[0];
			assert.match(await api.updateSavedEvents(response({ additions: [{
				event_id: event.id, title: 'Due', date: '15/10/2026'
			}] }), 'page', '1', 'other-course', null), /this course/);
			assert.equal((await db.query('SELECT * FROM SavedEvents')).length, initial);
			assert.equal(await api.updateSavedEvents(response({ new_events: [{
				title: 'No additions array', description: 'x', dates: [{ title: 'Due', date: '29/02/2028' }]
			}] }), 'page', '1', '1', null), null);
			const saved = (await db.query("SELECT * FROM SavedEvents WHERE title = 'No additions array'"))[0];
			assert.equal((await db.query('SELECT time FROM DateFacts WHERE applies_to = ?', [saved.id]))[0].time, null);
			await db.close();
		});
		await t.test('removed course deletes all dependent data', async () => {
			empty = true;
			await api.main();
			for (const table of ['Courses', 'Modules', 'Pages', 'Assignments', 'Quizzes', 'Discussions', 'Files', 'Externals', 'SavedEvents', 'CreationFacts', 'DateFacts']) {
				assert.equal((await db.query('SELECT * FROM ' + table)).length, 0, table);
			}
			await db.close();
		});
		await t.test('pagination failure returns no partial result and origin mismatch sends no credentials', async () => {
			let calls = 0;
			globalThis.fetch = async () => {
				calls++;
				return calls === 1 ? json([{ id: 1 }], { link: '<https://canvas.test/next>; rel="next"' }) :
					new Response('', { status: 500 });
			};
			const [data, error] = await api.fetchData('https://canvas.test/list');
			assert.equal(data, null); assert.match(error, /500/);
			calls = 0;
			assert.match((await api.fetchData('https://other.test/list'))[1], /origin/);
			assert.equal(calls, 0);
		});
		await t.test('text extraction and Edmonton date formatting', async () => {
			assert.deepEqual(await api.extractFileText(Buffer.from('  Hello  '), 'file.txt'), ['Hello', null]);
			assert.match((await api.extractFileText(Buffer.from('data'), 'file.unknown'))[1], /Unsupported/);
			assert.equal(api.formatCanvasDate('2026-10-15T20:00:00Z'), '15/10/2026 14:00');
			assert.equal(api.formatCanvasDate(null), 'No date');
		});
	} finally {
		globalThis.fetch = originalFetch;
		await db.close();
		await unlink(process.env.CANVAS_DB_PATH).catch(error => { if (error.code !== 'ENOENT') throw error; });
		await rmdir(directory);
	}
});

