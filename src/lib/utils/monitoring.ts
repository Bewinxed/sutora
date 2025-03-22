// src/lib/utils/monitoring.ts
import { db } from '$lib/server/db';
import { resourceMetrics, comfyInstances, envVars } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getGPUInfo, getSystemMetrics } from './platformUtils';

/**
 * Record metrics for all running instances
 */
export async function recordMetrics() {
	try {
		// Get all running instances
		const instances = await db
			.select()
			.from(comfyInstances)
			.where(eq(comfyInstances.status, 'running'));

		if (instances.length === 0) {
			return; // No running instances
		}

		// Get path to comfyUI from environment variables
		const comfyuiPathResult = await db
			.select()
			.from(envVars)
			.where(eq(envVars.key, 'COMFYUI_PATH'));
		if (comfyuiPathResult.length === 0) {
			console.warn('ComfyUI path not set in environment variables');
			return;
		}
		const comfyuiPath = comfyuiPathResult[0].value;

		// Get GPU metrics
		const gpuInfo = await getGPUInfo(comfyuiPath);

		// Get system metrics
		const systemMetrics = await getSystemMetrics();

		// Record metrics for each instance
		for (const instance of instances) {
			const gpuIndices = instance.gpuIndices.split(',').map((idx) => parseInt(idx.trim()));

			for (const gpuIndex of gpuIndices) {
				const gpuDevice = gpuInfo.devices.find((device) => device.index === gpuIndex);

				if (gpuDevice) {
					await db.insert(resourceMetrics).values({
						instanceId: instance.id,
						gpuIndex,
						vramUsed: gpuDevice.memoryUsed || 0,
						vramTotal: gpuDevice.memoryTotal || 0,
						gpuUtilization: gpuDevice.utilization || 0,
						ramUsed: systemMetrics.ramUsed,
						cpuUtilization: systemMetrics.cpuUtilization
					});
				}
			}
		}
	} catch (error) {
		console.error('Error recording metrics:', error);
	}
}

/**
 * Start monitoring at specified interval (in ms)
 * @returns The interval ID for cleanup
 */
export function startMonitoring(interval: number = 5000): Timer {
	console.log(`Starting resource monitoring at ${interval}ms intervals`);
	return setInterval(recordMetrics, interval);
}

/**
 * Stop monitoring
 * @param intervalId The interval ID to clear
 */
export function stopMonitoring(intervalId: Timer): void {
	clearInterval(intervalId);
	console.log('Resource monitoring stopped');
}
