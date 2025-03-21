// src/lib/server/routes/env/index.ts
import { Elysia, t } from 'elysia';
import { db } from '$lib/server/db';
import { envVars } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { ElysiaApp } from '../+server';

export default (app: ElysiaApp) =>
	app
		// Get all environment variables
		.get('/', async () => {
			return await db.select().from(envVars);
		})

		// Get a specific environment variable
		.get('/:key', async ({ params }) => {
			const result = await db.select().from(envVars).where(eq(envVars.key, params.key));
			if (result.length === 0) {
				return new Response(JSON.stringify({ error: 'Environment variable not found' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			return result[0];
		})

		// Set an environment variable
		.post(
			'/',
			async ({ body }) => {
				try {
					await db
						.insert(envVars)
						.values({
							key: body.key,
							value: body.value,
							description: body.description || null
						})
						.onConflictDoUpdate({
							target: envVars.key,
							set: {
								value: body.value,
								description: body.description,
								updatedAt: new Date()
							}
						});

					return { success: true, key: body.key };
				} catch (error) {
					return new Response(JSON.stringify({ error: String(error) }), {
						status: 500,
						headers: { 'Content-Type': 'application/json' }
					});
				}
			},
			{
				body: t.Object({
					key: t.String(),
					value: t.String(),
					description: t.Optional(t.String())
				})
			}
		)

		// Delete an environment variable
		.delete('/:key', async ({ params }) => {
			await db.delete(envVars).where(eq(envVars.key, params.key));
			return { success: true, key: params.key };
		});
