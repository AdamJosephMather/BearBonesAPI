import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.CANVAS_TOKEN = 'test-token';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.CANVAS_BASE_URL = 'https://canvas.test/api/v1/';
const directory = await mkdtemp(path.join(os.tmpdir(), 'canvas-interface-test-'));
process.env.CANVAS_DB_PATH = path.join(directory, 'sync.db');
process.env.USER_DB_PATH = path.join(directory, 'users.db');
const api = await import('../CanvasInterface.js');
const { DatabaseManager } = await import('../db/node-adapter.js');
const db = new DatabaseManager(process.env.CANVAS_DB_PATH);
const users = new DatabaseManager(process.env.USER_DB_PATH);
const sync = async () => { await api.getClientSync('test-token'); await api.canvasSync(); };
const json = (data, headers = {}) => new Response(JSON.stringify(data), { headers });
const modelResult = (title = 'Deadline') => ({ choices: [{ message: { content: JSON.stringify({
	new_events: [{ title, description: 'Details', dates: [{ title: 'Due', date: '15/10/2026', time: '14:00' }] }],
	additions: []
}) } }] });

test('Canvas sync regression coverage with mocked HTTP and real SQLite', async t => {
	const originalFetch = globalThis.fetch;
	let version = 1, courseName = 'Course', modelCalls = 0, failModel = false, forbidden = false, empty = false;
	let fallback = false, omitPage = false, listStatus = 200, revoked = new Set();
	let duringModel;
	let failModelAt;
	const assignment = id => ({
		id, name: 'Assignment ' + id, updated_at: 'unchanged',
		due_at: version === 1 ? '2026-10-15T20:00:00Z' : '2026-10-16T20:00:00Z',
		description: 'Assignment ' + version, allowed_attempts: 2, points_possible: 5,
		has_submitted_submissions: true, locked_for_user: false,
		graded_submissions_exist: false, is_quiz_assignment: false
	});
	globalThis.fetch = async (url, options) => {
		url = new URL(url);
		if (url.hostname === 'openrouter.ai') {
			modelCalls++;
			if (duringModel) { const callback = duringModel; duringModel = undefined; await callback(); }
			assert.equal(options.method, 'POST');
			const body = JSON.parse(options.body);
			assert.equal(typeof body.messages[0].content, 'string');
			assert.equal(options.headers.Authorization, 'Bearer test-key');
			if (failModel || modelCalls === failModelAt) return json({ choices: [{ message: { content: 'bad JSON' } }] });
			return json(modelResult());
		}
		if (url.hostname === 'download.test') return new Response('Deadline is October 15.');
		assert.ok(['Bearer test-token', 'Bearer second-token'].includes(options.headers.Authorization));
		if (revoked.has(options.headers.Authorization)) return new Response('', { status: 401 });
		switch (url.pathname) {
			case '/api/v1/courses':
				if (listStatus !== 200) return new Response('', { status: listStatus });
				return json(empty ? [] : [{ id: 1, name: courseName, uuid: 'uuid' }]);
			case '/api/v1/courses/1':
				return json({ id: 1, name: courseName, uuid: 'uuid' });
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
				return json({ id: 20, title: 'Quiz', description: 'Quiz ' + version, version_number: version, published: true, locked_for_user: false, due_at: '2026-11-20T20:00:00Z', assignment_id: 50, all_dates: [{ base: true, due_at: '2026-10-15T20:00:00Z' }] });
			case '/discussion':
				return json({ id: 30, title: 'Discussion', message: 'Message ' + version, published: true, locked_for_user: false });
			case '/file':
				return json({ id: 40, display_name: 'File', filename: 'file.txt', updated_at: String(version), url: 'https://download.test/file', hidden_for_user: false, locked_for_user: false });
			case '/api/v1/courses/1/assignments':
				if (!url.searchParams.has('page')) assert.equal(url.searchParams.get('override_assignment_dates'), 'false');
				return url.searchParams.has('page') ? json([assignment(51)]) :
					json([assignment(50)], { link: '<https://canvas.test/api/v1/courses/1/assignments?page=2>; rel="next"' });
			case '/api/v1/courses/1/assignments/52':
				return json(assignment(52));
			default: throw new Error('Unexpected mocked URL: ' + url);
		}
	};
	try {
		await t.test('first client registration returns an unsynced payload and does no AI work', async () => {
			const result = await api.getClientSync('test-token');
			assert.equal(result.token_good, true);
			assert.equal(result.courses[0].course_id, '1');
			assert.equal(result.courses[0].last_update, -1);
			assert.equal(result.started_index_of_course, true);
			assert.equal(modelCalls, 0);
		});
		await t.test('initial sync creates valid tables and all source types; pagination includes the second assignment', async () => {
			await sync();
			assert.equal(modelCalls, 6);
			assert.equal((await db.query('SELECT * FROM Assignments')).length, 2);
			assert.equal((await db.query('SELECT * FROM SavedEvents')).length, 6);
			const facts = await db.query('SELECT from_type, from_id FROM CreationFacts');
			assert.ok(facts.some(row => row.from_type === 'page' && row.from_id === '11'));
			assert.ok(facts.some(row => row.from_type === 'assignment' && row.from_id === '50'));
			assert.ok(facts.some(row => row.from_type === 'quiz' && row.from_id === '20'));
			assert.ok(!(await db.query('PRAGMA table_info(Assignments)')).some(row => row.name === 'has_submitted_submissions'));
			await db.close();
		});
		await t.test('cleanup is limited to courses successfully synced in this run', async () => {
			await db.run('INSERT INTO Courses (id, name) VALUES (?, ?)', ['999', 'Unavailable course']);
			await db.run('INSERT INTO Pages (id, course_id, title) VALUES (?, ?, ?)', ['999', '999', 'Keep this page']);
			await db.close();
			await api.canvasSync();
			assert.equal((await db.query('SELECT * FROM Pages WHERE course_id = ?', ['999'])).length, 1);
			await db.run('DELETE FROM Pages WHERE course_id = ?', ['999']);
			await db.run('DELETE FROM Courses WHERE id = ?', ['999']);
			await db.close();
		});
		await t.test('users share snapshots and concurrent registrations do not duplicate tokens', async () => {
			const before = modelCalls;
			const [first, second] = await Promise.all([api.getClientSync('test-token'), api.getClientSync('second-token')]);
			assert.deepEqual(first.courses, second.courses);
			await Promise.all([api.getClientSync('second-token'), api.getClientSync('second-token')]);
			assert.equal((await users.query('SELECT * FROM TokenForCourses')).length, 2);
			assert.equal(modelCalls, before);
			const course = first.courses[0];
			assert.ok(course.last_update > 0);
			assert.equal(course.events.length, 6);
			for (const key of ['assignments', 'quizzes', 'pages', 'files', 'discussions', 'externals', 'modules']) assert.ok(course[key].length);
			assert.equal(course.quizzes[0].assignment_id, '50');
			assert.equal(course.quizzes[0].due_at, '2026-10-15T20:00:00Z');
			assert.equal(course.assignments[0].submission_url, 'https://canvas.test/api/v1/courses/1/assignments/50/submissions/self');
			assert.equal(course.quizzes[0].submission_url, 'https://canvas.test/api/v1/courses/1/quizzes/20/submission');
			assert.equal(course.files[0].api_url, 'https://canvas.test/api/v1/files/40');
			assert.ok(course.events.some(event => event.sources.some(source => source.type === 'assignment' && source.submission_url)));
			const serialized = JSON.stringify(course);
			for (const privateValue of ['locked_for_user', 'hidden_for_user', 'has_submitted_submissions', 'graded_submissions_exist', 'download.test', 'test-token', 'second-token']) assert.ok(!serialized.includes(privateValue), privateValue);
		});
		await t.test('temporary errors retain tokens and authentication errors retain remembered snapshots', async () => {
			listStatus = 500;
			assert.equal((await api.getClientSync('test-token')).token_good, false);
			assert.equal((await users.query('SELECT * FROM TokenForCourses')).length, 2);
			listStatus = 401;
			const result = await api.getClientSync('test-token');
			assert.equal(result.token_good, false);
			assert.equal(result.courses[0].course_id, '1');
			assert.ok(result.courses[0].last_update > 0);
			assert.equal((await users.query('SELECT * FROM TokenForCourses')).length, 1);
			listStatus = 200;
			await api.getClientSync('test-token');
		});
		await t.test('background sync falls back to another user and retains data when all tokens fail', async () => {
			revoked.add('Bearer test-token');
			await api.canvasSync();
			assert.equal((await users.query('SELECT * FROM TokenForCourses')).length, 1);
			revoked.add('Bearer second-token');
			const previous = (await db.query('SELECT payload FROM CourseSnapshots'))[0].payload;
			await api.canvasSync();
			assert.equal((await users.query('SELECT * FROM TokenForCourses')).length, 0);
			assert.equal((await db.query('SELECT payload FROM CourseSnapshots'))[0].payload, previous);
			assert.equal((await db.query('SELECT * FROM Pages')).length, 1);
			revoked.clear();
		});
		await t.test('repeated sync is idempotent and course/module metadata is updated', async () => {
			courseName = 'Renamed';
			await sync();
			assert.equal(modelCalls, 6);
			assert.equal((await db.query('SELECT name FROM Courses'))[0].name, 'Renamed');
			assert.equal((await db.query('SELECT * FROM DateFacts')).length, 6);
			await db.close();
		});
		await t.test('source edits re-extract quizzes, discussions, assignments, files and pages', async () => {
			version = 2;
			await sync();
			assert.equal(modelCalls, 12);
			assert.equal((await db.query('SELECT * FROM SavedEvents')).length, 6);
			assert.equal((await db.query('SELECT title FROM Externals'))[0].title, 'External 2');
			assert.equal((await db.query('SELECT name FROM Modules'))[0].name, 'Module 2');
			await db.close();
		});
		await t.test('invalid model response rolls back replacement and leaves prior source/facts intact', async () => {
			const previous = (await db.query('SELECT payload FROM CourseSnapshots'))[0].payload;
			version = 3; failModel = true;
			duringModel = async () => {
				assert.equal(await api.canvasSync(), 'Already syncing');
				const client = await api.getClientSync('second-token');
				assert.equal(JSON.stringify(client.courses[0]), previous);
			};
			await assert.rejects(sync(), /Failed to save AI response/);
			assert.equal((await db.query('SELECT payload FROM CourseSnapshots'))[0].payload, previous);
			assert.equal((await db.query('SELECT body FROM Pages'))[0].body, 'Body 2');
			assert.equal((await db.query('SELECT * FROM SavedEvents')).length, 6);
			await db.close();
			version = 2; failModel = false;
		});
		await t.test('403 aborts cleanup and retains inaccessible records', async () => {
			forbidden = true;
			await assert.rejects(sync(), /403/);
			assert.equal((await db.query('SELECT * FROM Pages')).length, 1);
			await db.close(); forbidden = false;
		});
		await t.test('interrupted sync keeps completed AI work and retries only unfinished sources', async () => {
			const previous = (await db.query('SELECT payload FROM CourseSnapshots'))[0].payload;
			const before = modelCalls;
			version = 3;
			failModelAt = before + 2; // Page completes; quiz fails.
			await assert.rejects(sync(), /Failed to save AI response/);
			await db.close(); // Reopen SQLite to check durability beyond the sync connection.
			assert.equal((await db.query('SELECT body FROM Pages'))[0].body, 'Body 3');
			assert.equal((await db.query('SELECT description FROM Quizzes'))[0].description, 'Quiz 2');
			assert.equal((await db.query("SELECT COUNT(*) AS count FROM CreationFacts WHERE from_type = 'page'"))[0].count, 1);
			assert.equal((await db.query('SELECT payload FROM CourseSnapshots'))[0].payload, previous);
			assert.equal(JSON.stringify((await api.getClientSync('test-token')).courses[0]), previous);
			await db.close();

			failModelAt = modelCalls + 5; // Retry skips page, then fails on the second bulk assignment.
			await assert.rejects(sync(), /Failed to save AI response/);
			assert.equal(modelCalls, before + 7);
			assert.equal((await db.query('SELECT description FROM Assignments WHERE id = ?', ['50']))[0].description, 'Assignment 3');
			assert.equal((await db.query('SELECT description FROM Assignments WHERE id = ?', ['51']))[0].description, 'Assignment 2');
			assert.equal((await db.query('SELECT payload FROM CourseSnapshots'))[0].payload, previous);
			await db.close();

			failModelAt = undefined;
			await sync();
			assert.equal(modelCalls, before + 8); // Only assignment 51 still needs AI.
			const published = (await api.getClientSync('test-token')).courses[0];
			assert.equal(published.pages[0].body, 'Body 3');
			assert.ok(published.assignments.every(row => row.description === 'Assignment 3'));
			assert.equal(published.events.length, 6); // Cleanup removed superseded orphan events.
			assert.equal((await db.query('SELECT * FROM CreationFacts')).length, 6);
			await db.close();
			const completed = modelCalls;
			await sync();
			assert.equal(modelCalls, completed);
			version = 2;
			await sync();
		});
		await t.test('individual assignment fallback succeeds and returns a success result', async () => {
			fallback = true;
			await sync();
			assert.ok((await db.query('SELECT * FROM Assignments')).some(row => row.id === '52'));
			await db.close();
		});
		await t.test('removed sources delete associated facts and orphan events', async () => {
			omitPage = true;
			await sync();
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
		await t.test('unenrollment removes registrations but retains course caches for other users', async () => {
			empty = true;
			await api.getClientSync('second-token');
			await sync();
			assert.equal((await api.getClientSync('test-token')).courses.length, 0);
			assert.equal((await users.query('SELECT * FROM TokenForCourses')).length, 0);
			assert.equal((await db.query('SELECT * FROM CourseSnapshots')).length, 1);
			assert.equal((await db.query('SELECT * FROM Assignments')).length, 3);
			empty = false;
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
		await api.stop();
		await users.close();
		await unlink(process.env.USER_DB_PATH);
		await unlink(process.env.CANVAS_DB_PATH).catch(error => { if (error.code !== 'ENOENT') throw error; });
		await rmdir(directory);
	}
});

