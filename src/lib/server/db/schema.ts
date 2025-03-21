import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const user = sqliteTable('user', {
	id: text('id').primaryKey(),
	age: integer('age'),
	username: text('username').notNull().unique(),
	passwordHash: text('password_hash').notNull()
});

export const session = sqliteTable('session', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull()
});

// Table for storing environment variables and configuration
export const envVars = sqliteTable('env_vars', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	description: text('description'),
	updatedAt: integer('updated_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

// Table for storing ComfyUI instances
export const comfyInstances = sqliteTable('comfy_instances', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text('name').notNull(),
	port: integer('port').notNull(),
	gpuIndices: text('gpu_indices').notNull(), // Comma-separated list of GPU indices (e.g., "0,1")
	status: text('status')
		.notNull()
		.$default(() => 'stopped'), // 'running', 'stopped', 'error'
	options: text('options')
		.notNull()
		.$default(() => '{}'), // JSON string of ComfyUI options
	pid: integer('pid'), // Process ID when running
	lastError: text('last_error'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

// Table for job queue
export const jobQueue = sqliteTable('job_queue', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	workflowData: text('workflow_data').notNull(), // JSON string of workflow data
	priority: integer('priority')
		.notNull()
		.$default(() => 0), // Higher number = higher priority
	status: text('status')
		.notNull()
		.$default(() => 'pending'), // 'pending', 'running', 'completed', 'failed'
	instanceId: text('instance_id').references(() => comfyInstances.id),
	output: text('output'), // Output data as JSON string
	error: text('error'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

// Table for resource monitoring
export const resourceMetrics = sqliteTable('resource_metrics', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	instanceId: text('instance_id').references(() => comfyInstances.id),
	timestamp: integer('timestamp', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	gpuIndex: integer('gpu_index').notNull(),
	vramUsed: integer('vram_used'), // In MB
	vramTotal: integer('vram_total'), // In MB
	gpuUtilization: integer('gpu_utilization'), // Percentage
	ramUsed: integer('ram_used'), // In MB
	cpuUtilization: integer('cpu_utilization') // Percentage
});

export type Session = typeof session.$inferSelect;

export type User = typeof user.$inferSelect;
