// src/lib/utils/monitoring.ts
import { $ } from 'bun';
import { db } from '$lib/server/db';
import { resourceMetrics, comfyInstances } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// Interface for GPU metrics
interface GPUMetrics {
	index: number;
	name: string;
	temperature: number;
	fanSpeed: number;
	powerUsage: number;
	powerLimit: number;
	memoryUsed: number;
	memoryTotal: number;
	utilization: number;
}

// Parse nvidia-smi output to get GPU metrics
export async function getGPUMetrics(): Promise<GPUMetrics[]> {
	try {
		const output =
			await $`nvidia-smi --query-gpu=index,name,temperature.gpu,fan.speed,power.draw,power.limit,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits`.text();

		return output
			.trim()
			.split('\n')
			.map((line) => {
				const [
					index,
					name,
					temperature,
					fanSpeed,
					powerUsage,
					powerLimit,
					memoryUsed,
					memoryTotal,
					utilization
				] = line.split(', ').map((item) => item.trim());

				return {
					index: parseInt(index),
					name,
					temperature: parseInt(temperature),
					fanSpeed: parseInt(fanSpeed),
					powerUsage: parseFloat(powerUsage),
					powerLimit: parseFloat(powerLimit),
					memoryUsed: parseInt(memoryUsed),
					memoryTotal: parseInt(memoryTotal),
					utilization: parseInt(utilization)
				};
			});
	} catch (error) {
		console.error('Error fetching GPU metrics:', error);
		return [];
	}
}

// Get system metrics (CPU, RAM)
export async function getSystemMetrics() {
	try {
		// Get CPU utilization - much cleaner with Bun Shell!
		const cpuUtilization = parseFloat(
			await $`top -bn1 | grep 'Cpu(s)' | awk '{print $2 + $4}'`
				.text()
				.then((output) => output.trim())
		);

		// Get RAM usage
		const memInfo = await $`free -m | awk 'NR==2{printf "%s %s", $3, $2}'`
			.text()
			.then((output) => output.trim());
		const [ramUsed, ramTotal] = memInfo.split(' ').map((item) => parseInt(item));

		return {
			cpuUtilization,
			ramUsed,
			ramTotal,
			ramUtilization: (ramUsed / ramTotal) * 100
		};
	} catch (error) {
		console.error('Error fetching system metrics:', error);
		return {
			cpuUtilization: 0,
			ramUsed: 0,
			ramTotal: 0,
			ramUtilization: 0
		};
	}
}

// Record metrics for all running instances
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

		// Get GPU metrics
		const gpuMetrics = await getGPUMetrics();

		// Get system metrics
		const systemMetrics = await getSystemMetrics();

		// Record metrics for each instance
		for (const instance of instances) {
			const gpuIndices = instance.gpuIndices.split(',').map((idx) => parseInt(idx.trim()));

			for (const gpuIndex of gpuIndices) {
				const gpuMetric = gpuMetrics.find((metric) => metric.index === gpuIndex);

				if (gpuMetric) {
					await db.insert(resourceMetrics).values({
						instanceId: instance.id,
						gpuIndex,
						vramUsed: gpuMetric.memoryUsed,
						vramTotal: gpuMetric.memoryTotal,
						gpuUtilization: gpuMetric.utilization,
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

// Start monitoring at specified interval (in ms)
export function startMonitoring(interval: number = 5000) {
	console.log(`Starting resource monitoring at ${interval}ms intervals`);
	return setInterval(recordMetrics, interval);
}

// Stop monitoring
export function stopMonitoring(intervalId: NodeJS.Timeout) {
	clearInterval(intervalId);
	console.log('Resource monitoring stopped');
}
