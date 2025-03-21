// src/routes/api/[...slugs]/index.ts
import { Elysia } from 'elysia';
import { autoload } from 'elysia-autoload';
import path from 'path';

// Initialize the Elysia app with autoload
const app = new Elysia({ prefix: '/api' }).use(
	await autoload({
		dir: path.join(process.cwd(), 'src', 'lib', 'server', 'routes'),
		prefix: '/api'
	})
);

// SvelteKit handler
export const GET = ({ request }) => app.handle(request);
export const POST = ({ request }) => app.handle(request);
export const PUT = ({ request }) => app.handle(request);
export const DELETE = ({ request }) => app.handle(request);
export const PATCH = ({ request }) => app.handle(request);
export const OPTIONS = ({ request }) => app.handle(request);

// Export the app type for usage in route handlers
export type ElysiaApp = typeof app;
