import { DatabaseSync } from 'node:sqlite';

let db_path = "canvas_db.db";

let db;
function getDb() {
	if (!db) db = new DatabaseSync(db_path);
	return db;
}

export function setDbPath(newpath) {
	if (db && newpath !== db_path) {
		db.close();
		db = null;
	}
	db_path = newpath;
}

// node:sqlite accepts numbers and null, but not booleans or undefined.
function bindParams(params) {
	return params.map(value => value == null ? null :
		typeof value === 'boolean' ? Number(value) : value);
}

export async function execute(sql) {
	getDb().exec(sql);
}

export async function run(sql, params = []) {
	const info = getDb().prepare(sql).run(...bindParams(params));
	return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

export async function query(sql, params = []) {
	return getDb().prepare(sql).all(...bindParams(params));
}

export async function close() {
	if (db) db.close();
	db = null;
}
