// src/lib/server/routes/config/python.ts
import { Elysia, t } from 'elysia';
import { validatePython, findPythonInVenv, findSystemPython } from '$lib/utils/pythonUtils';
import { db } from '$lib/server/db';
import { envVars } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { ElysiaApp } from '../+server';

export default (app: ElysiaApp) =>
	app
		// Get the current Python path
		.get('/', async () => {
			const result = await db.select().from(envVars).where(eq(envVars.key, 'PYTHON_PATH'));
			if (result.length === 0) {
				return { pythonPath: null };
			}
			return {
				pythonPath: result[0].value,
				description: result[0].description
			};
		})

		// Set the Python path
		.post(
			'/',
			async ({ body }) => {
				try {
					// Validate the Python path
					const validation = await validatePython(body.pythonPath);

					if (!validation.valid) {
						return new Response(
							JSON.stringify({
								error: `Invalid Python path: ${validation.error}`
							}),
							{
								status: 400,
								headers: { 'Content-Type': 'application/json' }
							}
						);
					}

					// Save the validated Python path directly to database
					await db
						.insert(envVars)
						.values({
							key: 'PYTHON_PATH',
							value: body.pythonPath,
							description:
								body.description || `User-configured Python path (${validation.version})`,
							updatedAt: new Date()
						})
						.onConflictDoUpdate({
							target: envVars.key,
							set: {
								value: body.pythonPath,
								description:
									body.description || `User-configured Python path (${validation.version})`,
								updatedAt: new Date()
							}
						});

					return {
						success: true,
						pythonPath: body.pythonPath,
						version: validation.version
					};
				} catch (error) {
					return new Response(JSON.stringify({ error: String(error) }), {
						status: 500,
						headers: { 'Content-Type': 'application/json' }
					});
				}
			},
			{
				body: t.Object({
					pythonPath: t.String(),
					description: t.Optional(t.String())
				})
			}
		)

		// Auto-detect Python in virtual environments
		.post(
			'/detect',
			async ({ body }) => {
				try {
					const comfyuiPath = body.comfyuiPath;

					// Try to find Python in a virtual environment
					const venvPython = await findPythonInVenv(comfyuiPath);

					if (venvPython) {
						const validation = await validatePython(venvPython);

						if (validation.valid) {
							// Store the detected path directly to database
							await db
								.insert(envVars)
								.values({
									key: 'PYTHON_PATH',
									value: venvPython,
									description: `Auto-detected virtual environment (${validation.version})`,
									updatedAt: new Date()
								})
								.onConflictDoUpdate({
									target: envVars.key,
									set: {
										value: venvPython,
										description: `Auto-detected virtual environment (${validation.version})`,
										updatedAt: new Date()
									}
								});

							return {
								success: true,
								pythonPath: venvPython,
								venv: true,
								version: validation.version
							};
						}
					}

					// If no venv found, return the system Python
					const systemPython = await findSystemPython();
					const validation = await validatePython(systemPython);

					return {
						success: validation.valid,
						pythonPath: systemPython,
						venv: false,
						version: validation.valid ? validation.version : undefined,
						warning:
							'No virtual environment detected. Using system Python may not work if ComfyUI dependencies are installed in a venv.'
					};
				} catch (error) {
					return new Response(JSON.stringify({ error: String(error) }), {
						status: 500,
						headers: { 'Content-Type': 'application/json' }
					});
				}
			},
			{
				body: t.Object({
					comfyuiPath: t.String()
				})
			}
		);
