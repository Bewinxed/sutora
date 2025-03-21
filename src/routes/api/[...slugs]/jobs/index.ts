// src/lib/server/routes/jobs/index.ts
import { Elysia, t } from 'elysia';
import { db } from '$lib/server/db';
import { jobQueue, comfyInstances } from '$lib/server/db/schema';
import { eq, and, or, desc, asc } from 'drizzle-orm';
import { $ } from 'bun';
import type { ElysiaApp } from '../+server';

export default (app: ElysiaApp) =>
	app
		// Get all jobs
		.get('/', async () => {
			return await db.select().from(jobQueue);
		})

		// Get a specific job
		.get('/:id', async ({ params }) => {
			const result = await db.select().from(jobQueue).where(eq(jobQueue.id, params.id));
			if (result.length === 0) {
				return new Response(JSON.stringify({ error: 'Job not found' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			return result[0];
		})

		// Create a new job
		.post(
			'/',
			async ({ body }) => {
				try {
					const result = await db
						.insert(jobQueue)
						.values({
							workflowData: JSON.stringify(body.workflow),
							priority: body.priority || 0,
							instanceId: body.instanceId // Optional, can be assigned later
						})
						.returning();

					// If no specific instance was selected, find an available one
					if (!body.instanceId) {
						// Schedule the job to be picked up by the next available instance
						await scheduleNextJob();
					}

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
					workflow: t.Any(),
					priority: t.Optional(t.Number()),
					instanceId: t.Optional(t.String())
				})
			}
		)

		// Cancel a job
		.post('/:id/cancel', async ({ params }) => {
			try {
				const result = await db
					.update(jobQueue)
					.set({
						status: 'cancelled',
						updatedAt: new Date()
					})
					.where(
						and(
							eq(jobQueue.id, params.id),
							or(eq(jobQueue.status, 'pending'), eq(jobQueue.status, 'running'))
						)
					)
					.returning();

				if (result.length === 0) {
					return new Response(JSON.stringify({ error: 'Job not found or cannot be cancelled' }), {
						status: 404,
						headers: { 'Content-Type': 'application/json' }
					});
				}

				// If the job was running, we might need to cancel it on the instance
				if (result[0].status === 'running' && result[0].instanceId) {
					const instance = await db
						.select()
						.from(comfyInstances)
						.where(eq(comfyInstances.id, result[0].instanceId));

					if (instance.length > 0 && instance[0].port) {
						// Send a cancel request to the ComfyUI instance
						try {
							await $`curl -X POST http://localhost:${instance[0].port}/interrupt`.quiet();
						} catch (error) {
							console.error(`Failed to interrupt job on instance: ${error}`);
						}
					}
				}

				return { success: true, job: result[0] };
			} catch (error) {
				return new Response(JSON.stringify({ error: String(error) }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		});

// Function to schedule the next job in the queue
async function scheduleNextJob() {
	// Find running instances
	const runningInstances = await db
		.select()
		.from(comfyInstances)
		.where(eq(comfyInstances.status, 'running'));

	if (runningInstances.length === 0) {
		console.log('No running instances available to process jobs');
		return;
	}

	// Find instances that are not currently processing a job
	const busyInstanceIds = (
		await db.select().from(jobQueue).where(eq(jobQueue.status, 'running'))
	).map((job) => job.instanceId);

	const availableInstances = runningInstances.filter(
		(instance) => !busyInstanceIds.includes(instance.id)
	);

	if (availableInstances.length === 0) {
		console.log('All instances are busy');
		return;
	}

	// Get the highest priority pending job
	const pendingJobs = await db
		.select()
		.from(jobQueue)
		.where(eq(jobQueue.status, 'pending'))
		.orderBy(desc(jobQueue.priority), asc(jobQueue.createdAt))
		.limit(1);

	if (pendingJobs.length === 0) {
		console.log('No pending jobs in queue');
		return;
	}

	const job = pendingJobs[0];
	const instance = availableInstances[0]; // Use the first available instance

	// Update job status and assign instance
	await db
		.update(jobQueue)
		.set({
			status: 'running',
			instanceId: instance.id,
			updatedAt: new Date()
		})
		.where(eq(jobQueue.id, job.id));

	// Submit job to ComfyUI instance
	try {
		// Parse the workflow data
		const workflow = JSON.parse(job.workflowData);

		// Submit to ComfyUI API
		const response =
			await $`curl -X POST -H "Content-Type: application/json" -d ${JSON.stringify(workflow)} http://localhost:${instance.port}/prompt`.json();

		console.log(
			`Job ${job.id} submitted to instance ${instance.id}, prompt ID: ${response.prompt_id}`
		);

		// We could store the prompt_id for tracking the job's progress
	} catch (error) {
		console.error(`Error submitting job ${job.id} to instance ${instance.id}:`, error);

		// Mark job as failed
		await db
			.update(jobQueue)
			.set({
				status: 'failed',
				error: String(error),
				updatedAt: new Date()
			})
			.where(eq(jobQueue.id, job.id));

		// Try to schedule the next job
		scheduleNextJob();
	}
}
