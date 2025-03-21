import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import * as schema from './schema';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const client = new Database(process.env.DATABASE_URL);

export const db = drizzle(client, {
	schema
});
