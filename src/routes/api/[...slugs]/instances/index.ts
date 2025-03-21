// src/lib/server/routes/instances/index.ts
import { Elysia, t } from 'elysia';
import { $} from 'bun';
import { db } from '$lib/server/db';
import { comfyInstances, envVars } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { launchComfyUI, stopComfyInstance, type ComfyUIOptions } from '$lib/utils/comfyuiCli';
import type { ElysiaApp } from '../+server';
import { findAvailablePort } from '$lib/utils/portUtils';

export default (app: ElysiaApp) =>
	app
		// Get all instances
		.get('/', async () => {
			return await db.select().from(comfyInstances);
		})

		// Get a specific instance
		.get('/:id', async ({ params }) => {
			const result = await db.select().from(comfyInstances).where(eq(comfyInstances.id, params.id));
			if (result.length === 0) {
				return new Response(JSON.stringify({ error: 'Instance not found' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			return result[0];
		})

		// Create a new instance
		.post(
			'/',
			async ({ body }) => {
				try {
					// Parse options into JSON string
					const optionsString = JSON.stringify(body.options || {});

					const result = await db
						.insert(comfyInstances)
						.values({
							name: body.name,
							port: body.port,
							gpuIndices: Array.isArray(body.gpuIndices)
								? body.gpuIndices.join(',')
								: body.gpuIndices,
							options: optionsString
						})
						.returning();

					return result[0];
				} catch (error) {
					return new Response(JSON.stringify({ error: String(error) }), {
						status: 500,
						headers: { 'Content-Type': 'application/json' }
					});
				}
			},
			{
				body: t.Object({
					name: t.String(),
					port: t.Number(),
					gpuIndices: t.Union([t.String(), t.Array(t.Number())]),
					options: t.Optional(t.Object({}))
				})
			}
		)

		// Start an instance
		.post('/:id/start', async ({ params }) => {
			try {
				// Get the instance
				const instances = await db
					.select()
					.from(comfyInstances)
					.where(eq(comfyInstances.id, params.id));
				if (instances.length === 0) {
					return new Response(JSON.stringify({ error: 'Instance not found' }), {
						status: 404,
						headers: { 'Content-Type': 'application/json' }
					});
				}

				const instance = instances[0];

				// Get ComfyUI path from environment variables
				const pathResult = await db.select().from(envVars).where(eq(envVars.key, 'COMFYUI_PATH'));
				if (pathResult.length === 0) {
					return new Response(
						JSON.stringify({
							error: 'ComfyUI path not set. Please set COMFYUI_PATH environment variable.'
						}),
						{
							status: 400,
							headers: { 'Content-Type': 'application/json' }
						}
					);
				}

				const comfyuiPath = pathResult[0].value;

				// Parse options from JSON string
				const options: ComfyUIOptions = JSON.parse(instance.options);

				// Merge in required options
				options.port = instance.port;
				options.cudaDevice = parseInt(instance.gpuIndices.split(',')[0]);

				// Launch ComfyUI
				const comfyInstance = await launchComfyUI(
					comfyuiPath,
					options,
					(stdout) => {
						console.log(`[Instance ${instance.name}] ${stdout}`);
					},
					async (stderr) => {
						console.error(`[Instance ${instance.name}] Error: ${stderr}`);

						// Update instance status if there's an error
						await db
							.update(comfyInstances)
							.set({
								status: 'error',
								lastError: stderr,
								updatedAt: new Date()
							})
							.where(eq(comfyInstances.id, params.id));
					}
				);

				// Update instance in database
				await db
					.update(comfyInstances)
					.set({
						status: 'running',
						pid: comfyInstance.pid,
						updatedAt: new Date()
					})
					.where(eq(comfyInstances.id, params.id));

				return {
					success: true,
					id: params.id,
					status: 'running',
					pid: comfyInstance.pid
				};
			} catch (error) {
				console.error('Error starting instance:', error);

				// Update instance with error
				await db
					.update(comfyInstances)
					.set({
						status: 'error',
						lastError: String(error),
						updatedAt: new Date()
					})
					.where(eq(comfyInstances.id, params.id));

				return new Response(JSON.stringify({ error: String(error) }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		})

		// Stop an instance
		.post('/:id/stop', async ({ params }) => {
			try {
				// Get the instance
				const instances = await db
					.select()
					.from(comfyInstances)
					.where(eq(comfyInstances.id, params.id));
				if (instances.length === 0) {
					return new Response(JSON.stringify({ error: 'Instance not found' }), {
						status: 404,
						headers: { 'Content-Type': 'application/json' }
					});
				}

				const instance = instances[0];

				if (!instance.pid) {
					return new Response(JSON.stringify({ error: 'Instance is not running' }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' }
					});
				}

				// Kill the process
				try {
					process.kill(instance.pid, 'SIGTERM');
				} catch (killError) {
					console.error(`Error killing process ${instance.pid}:`, killError);
				}

				// Update instance status
				await db
					.update(comfyInstances)
					.set({
						status: 'stopped',
						pid: null,
						updatedAt: new Date()
					})
					.where(eq(comfyInstances.id, params.id));

				return {
					success: true,
					id: params.id,
					status: 'stopped'
				};
			} catch (error) {
				return new Response(JSON.stringify({ error: String(error) }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		})
		.get('/:id/health', async ({ params }) => {
			try {
				// Get the instance
				const instances = await db
					.select()
					.from(comfyInstances)
					.where(eq(comfyInstances.id, params.id));
				if (instances.length === 0) {
					return new Response(JSON.stringify({ error: 'Instance not found' }), {
						status: 404,
						headers: { 'Content-Type': 'application/json' }
					});
				}

				const instance = instances[0];

				if (!instance.pid || instance.status !== 'running') {
					return {
						id: params.id,
						status: instance.status,
						healthy: false,
						message: 'Instance is not running'
					};
				}

				// Check if process is actually running using Bun Shell
				const checkResult = await $`ps -p ${instance.pid}`.nothrow().quiet();
				const isRunning = checkResult.exitCode === 0;

				// Check if the API is responding
				const port = instance.port;
				const apiCheckResult =
					await $`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/system_stats`
						.nothrow()
						.quiet();
				const isApiResponding =
					apiCheckResult.exitCode === 0 && (await apiCheckResult.text().trim()) === '200';

				// Update instance status if needed
				if (!isRunning || !isApiResponding) {
					await db
						.update(comfyInstances)
						.set({
							status: 'error',
							updatedAt: new Date()
						})
						.where(eq(comfyInstances.id, params.id));

					return {
						id: params.id,
						status: 'error',
						healthy: false,
						processRunning: isRunning,
						apiResponding: isApiResponding,
						message: 'Instance is not healthy'
					};
				}

				return {
					id: params.id,
					status: 'running',
					healthy: true,
					processRunning: true,
					apiResponding: true,
					message: 'Instance is healthy'
				};
			} catch (error) {
				console.error('Error checking instance health:', error);
				return new Response(JSON.stringify({ error: String(error) }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		})
		// Find an available port for a new instance
		.get('/available-port', async ({ query }) => {
			const basePort = Number(query.basePort) || 8188;
			const port = await findAvailablePort(basePort);
			return { port };
		});
