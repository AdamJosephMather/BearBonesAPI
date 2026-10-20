import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(os.tmpdir(), 'canvas-download-test-'));
process.env.CANVAS_DB_PATH = path.join(directory, 'canvas.db');
process.env.USER_DB_PATH = path.join(directory, 'users.db');
process.env.CANVAS_BASE_URL = 'https://canvas.test/api/v1/';
process.env.OPENROUTER_API_KEY = 'test-key';
const api = await import('../CanvasInterface.js');
const { DatabaseManager } = await import('../db/node-adapter.js');
const db = new DatabaseManager(process.env.CANVAS_DB_PATH);
const json = data => new Response(JSON.stringify(data));

test('page and module files handle relative URLs and restricted metadata without aborting sync', async () => {
	const originalFetch = globalThis.fetch;
	const downloads = [];
	let version = 1;
	let failDownload = false;
	const files = [
		{ id: '1', locked_for_user: true },
		{ id: '2', hidden_for_user: true, url: '/hidden' },
		{ id: '3' },
		{ id: '4', url: '/files/4/download' },
		{ id: '5', url: 'https://cdn.test/file.txt' },
		{ id: '6', url: '   ' }
	];
	globalThis.fetch = async (url, options) => {
		url = new URL(url);
		if (url.hostname === 'openrouter.ai') return json({ choices: [{ message: {
			content: JSON.stringify({ new_events: [], additions: [] })
		} }] });
		if (url.hostname === 'cdn.test' || url.pathname === '/files/4/download') {
			downloads.push(url.href);
			assert.equal(options.headers.Authorization,
				url.hostname === 'canvas.test' ? 'Bearer test-token' : undefined);
			return failDownload ? new Response('', { status: 500 }) : new Response('Deadline October 15');
		}
		assert.equal(options.headers.Authorization, 'Bearer test-token');
		switch (url.pathname) {
			case '/api/v1/courses': return json([{ id: '1' }]);
			case '/api/v1/courses/1': return json({ id: '1', name: 'Course' });
			case '/api/v1/courses/1/modules': return json([{ id: '10', name: 'Module', items_url: '/items' }]);
			case '/items': return json([
				{ id: '100', type: 'Page', url: '/page' },
				...files.map(file => ({ id: file.id, type: 'File', content_id: file.id,
					url: `/api/v1/courses/1/files/${file.id}` }))
			]);
			case '/page': return json({ page_id: '20', title: 'Resources', updated_at: String(version),
				body: files.map(file => `<a href="/courses/1/files/${file.id}">Resource</a>`).join('') });
			case '/api/v1/courses/1/assignments': return json([]);
			default: {
				const file = files.find(file => url.pathname === `/api/v1/courses/1/files/${file.id}`);
				assert.ok(file, 'Unexpected HTTP request: ' + url);
				return json({ ...file, filename: 'file.txt', display_name: 'File', updated_at: String(version) });
			}
		}
	};
	try {
		await api.getClientSync('test-token');
		await api.canvasSync();
		assert.deepEqual(downloads, [
			'https://canvas.test/files/4/download', 'https://cdn.test/file.txt',
			'https://canvas.test/files/4/download', 'https://cdn.test/file.txt'
		]);
		assert.deepEqual((await db.query('SELECT id FROM Files ORDER BY id')).map(row => row.id), ['4', '5']);
		const snapshot = (await db.query('SELECT payload FROM CourseSnapshots'))[0].payload;
		version++;
		failDownload = true;
		await assert.rejects(api.canvasSync(), /500/);
		assert.equal((await db.query('SELECT payload FROM CourseSnapshots'))[0].payload, snapshot);
		failDownload = false;
		await api.canvasSync();
		assert.equal((await db.query('SELECT updated_at FROM Pages'))[0].updated_at, '2');
	} finally {
		await api.stop();
		globalThis.fetch = originalFetch;
		await db.close();
		await rm(directory, { recursive: true, force: true });
	}
});
