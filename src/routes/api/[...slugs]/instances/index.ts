// src/routes/api/[...slugs]/instances/index.ts
import { Elysia, t } from 'elysia';
import { $ } from 'bun';
import { db } from '$lib/server/db';
import { comfyInstances, envVars } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { launchComfyUI, stopComfyInstance, type ComfyUIOptions } from '$lib/utils/comfyuiCli';
import type { ElysiaApp } from '../+server';
import { findAvailablePort } from '$lib/utils/portUtils';
import { isLinux, isMacOS, isWindows } from '$lib/utils/platformUtils';

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

					// Handle platform-specific GPU indices format
					let gpuIndices: string;

					if (Array.isArray(body.gpuIndices)) {
						gpuIndices = body.gpuIndices.join(',');
					} else if (typeof body.gpuIndices === 'string') {
						// macOS might use 'mps' or 'cpu' as a string
						gpuIndices = body.gpuIndices;
					} else {
						// Default to CPU if nothing is specified
						gpuIndices = 'cpu';
					}

					const result = await db
						.insert(comfyInstances)
						.values({
							name: body.name,
							port: body.port,
							gpuIndices: gpuIndices,
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

				// Set platform-specific options
				options.port = instance.port;

				// Handle different GPU formats based on platform
				if (isLinux || isWindows) {
					// For Linux/Windows, use CUDA device if available
					const gpuIndices = instance.gpuIndices.split(',');
					if (gpuIndices.length > 0 && gpuIndices[0] !== 'cpu') {
						options.cudaDevice = parseInt(gpuIndices[0]);
					}
				} else if (isMacOS) {
					// For macOS, check if using Metal (MPS)
					if (instance.gpuIndices === 'mps') {
						options.useMps = true;
					}
				}

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

				// Platform-specific process termination
				try {
					if (isLinux || isMacOS) {
						// On Unix-like systems, we can kill directly
						process.kill(instance.pid, 'SIGTERM');
					} else if (isWindows) {
						// On Windows, use taskkill
						await $`taskkill /PID ${instance.pid} /T /F`.quiet();
					}
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

				// Platform-specific process check
				let isRunning = false;
				if (isLinux || isMacOS) {
					// On Unix-like systems, we can use ps
					const checkResult = await $`ps -p ${instance.pid}`.nothrow().quiet();
					isRunning = checkResult.exitCode === 0;
				} else if (isWindows) {
					// On Windows, use tasklist
					const checkResult = await $`tasklist /FI "PID eq ${instance.pid}" /NH`.nothrow().quiet();
					isRunning = (await checkResult.text()).includes(instance.pid.toString());
				}

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
		})
		// Get available GPU options based on the platform
		.get('/gpu-options', async () => {
			try {
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

				// Create a temporary script to detect GPUs using PyTorch
				const scriptPath = '/tmp/detect_gpus.py';
				await Bun.write(
					scriptPath,
					`
import torch
import json
import sys

def get_gpu_options():
    results = {
        "platform": sys.platform,
        "options": []
    }
    
    # Check for CUDA (NVIDIA) GPUs
    if torch.cuda.is_available():
        cuda_count = torch.cuda.device_count()
        for i in range(cuda_count):
            results["options"].append({
                "type": "cuda",
                "index": i,
                "name": torch.cuda.get_device_name(i)
            })
    
    # Check for Apple Metal (MPS)
    if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        results["options"].append({
            "type": "mps",
            "index": "mps",
            "name": "Apple Metal GPU"
        })
    
    # Always include CPU as an option
    results["options"].append({
        "type": "cpu",
        "index": "cpu",
        "name": "CPU"
    })
    
    return results

print(json.dumps(get_gpu_options()))
`
				);

				// Get Python path and run the script
				const pythonPath = await $`which python3 || which python`.text().then((t) => t.trim());
				const result = await $`${pythonPath} ${scriptPath}`.text();

				// Clean up
				await $`rm ${scriptPath}`.quiet();

				// Parse and return the results
				return JSON.parse(result.trim());
			} catch (error) {
				console.error('Error getting GPU options:', error);
				return new Response(JSON.stringify({ error: String(error) }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		});
