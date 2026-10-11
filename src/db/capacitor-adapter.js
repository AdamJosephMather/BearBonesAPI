import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const DB_NAME = 'appdb';
const sqlite = new SQLiteConnection(CapacitorSQLite);
let dbConn;

async function getDb() {
	if (dbConn) return dbConn;
	const isConn = (await sqlite.isConnection(DB_NAME, false)).result;
	dbConn = isConn
		? await sqlite.retrieveConnection(DB_NAME, false)
		: await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
	await dbConn.open();
	return dbConn;
}

export async function execute(sql) {
	await (await getDb()).execute(sql);
}

export async function run(sql, params = []) {
	const res = await (await getDb()).run(sql, params);
	return { changes: res.changes.changes, lastInsertRowid: res.changes.lastId };
}

export async function query(sql, params = []) {
	const res = await (await getDb()).query(sql, params);
	return res.values ?? [];
}

export async function close() {
	await sqlite.closeConnection(DB_NAME, false);
	dbConn = null;
}