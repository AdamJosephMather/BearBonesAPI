import { DatabaseSync } from 'node:sqlite';

function bindParams(params) {
	return params.map(value => value == null ? null :
		typeof value === 'boolean' ? Number(value) : value);
}

export class DatabaseManager {
	constructor(dbPath) {
		this.dbPath = dbPath;
		this.db = null;
	}

	_getDb() {
		if (!this.db) {
			this.db = new DatabaseSync(this.dbPath);
			this.db.exec('PRAGMA busy_timeout = 5000;');
		}
		return this.db;
	}

	async execute(sql) {
		this._getDb().exec(sql);
	}

	async run(sql, params = []) {
		const info = this._getDb().prepare(sql).run(...bindParams(params));
		return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
	}

	async query(sql, params = []) {
		return this._getDb().prepare(sql).all(...bindParams(params));
	}

	async close() {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}
}