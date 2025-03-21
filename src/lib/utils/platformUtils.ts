// src/lib/utils/platformUtils.ts
import { $, type ShellPromise } from 'bun';
import { platform } from 'os';
import { getPythonPath } from './pythonUtils';
import path from 'path';
import type { ComfyUIOptions } from './comfyuiCli';

// Platform detection
export const isLinux = platform() === 'linux';
export const isMacOS = platform() === 'darwin';
export const isWindows = platform() === 'win32';

// Interfaces
export interface GPUDevice {
	index: number;
	name: string;
	memoryUsed?: number;
	memoryTotal?: number;
	utilization?: number;
	temperature?: number;
	fanSpeed?: number;
	powerUsage?: number;
	powerLimit?: number;
}

export interface GPUInfo {
	available: boolean;
	count: number;
	devices: GPUDevice[];
}

export interface SystemMetrics {
	cpuUtilization: number;
	ramUsed: number;
	ramTotal: number;
	ramUtilization: number;
}

/**
 * Get GPU information using the appropriate method for the current platform
 * @param comfyuiPath Path to ComfyUI installation (for accessing venv)
 */
export async function getGPUInfo(comfyuiPath: string): Promise<GPUInfo> {
	if (isLinux) {
		return await getLinuxGPUInfo();
	} else if (isMacOS) {
		return await getMacOSGPUInfo(comfyuiPath);
	} else if (isWindows) {
		return await getWindowsGPUInfo();
	}

	// Fallback for unsupported platforms
	return { available: false, count: 0, devices: [] };
}

/**
 * Get system metrics using the appropriate method for the current platform
 */
export async function getSystemMetrics(): Promise<SystemMetrics> {
	if (isLinux) {
		return await getLinuxSystemMetrics();
	} else if (isMacOS) {
		return await getMacOSSystemMetrics();
	} else if (isWindows) {
		return await getWindowsSystemMetrics();
	}

	// Fallback for unsupported platforms
	return {
		cpuUtilization: 0,
		ramUsed: 0,
		ramTotal: 0,
		ramUtilization: 0
	};
}

// ===================== LINUX IMPLEMENTATIONS =====================

/**
 * Get GPU information on Linux using nvidia-smi
 */
async function getLinuxGPUInfo(): Promise<GPUInfo> {
	try {
		const output =
			await $`nvidia-smi --query-gpu=index,name,temperature.gpu,fan.speed,power.draw,power.limit,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits`.text();

		if (!output || output.trim() === '') {
			return { available: false, count: 0, devices: [] };
		}

		const devices: GPUDevice[] = output
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

		return {
			available: devices.length > 0,
			count: devices.length,
			devices
		};
	} catch (error) {
		console.warn('Error fetching Linux GPU info:', error);
		return { available: false, count: 0, devices: [] };
	}
}

/**
 * Get system metrics on Linux
 */
async function getLinuxSystemMetrics(): Promise<SystemMetrics> {
	try {
		// Get CPU utilization
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
		console.warn('Error fetching Linux system metrics:', error);
		return {
			cpuUtilization: 0,
			ramUsed: 0,
			ramTotal: 0,
			ramUtilization: 0
		};
	}
}

// ===================== MACOS IMPLEMENTATIONS =====================

/**
 * Get GPU information on macOS using PyTorch from the ComfyUI venv
 */
async function getMacOSGPUInfo(comfyuiPath: string): Promise<GPUInfo> {
	try {
		// Get the Python executable from the ComfyUI venv
		const pythonPath = await getPythonPath(comfyuiPath);

		// Create a temporary Python script to get GPU info using PyTorch
		const scriptPath = path.join(comfyuiPath, 'temp_gpu_info.py');

		// Write the PyTorch script to get GPU info
		await Bun.write(
			scriptPath,
			`
import torch
import json

def get_gpu_info():
    gpu_available = torch.cuda.is_available() or hasattr(torch.backends, 'mps') and torch.backends.mps.is_available()
    
    if not gpu_available:
        return {"available": False, "count": 0, "devices": []}
    
    devices = []
    
    # Check for CUDA GPUs
    if torch.cuda.is_available():
        gpu_count = torch.cuda.device_count()
        for i in range(gpu_count):
            properties = torch.cuda.get_device_properties(i)
            devices.append({
                "index": i,
                "name": torch.cuda.get_device_name(i),
                "memoryTotal": properties.total_memory / (1024**2),  # MB
                "memoryUsed": 0,  # Not directly available through PyTorch
                "utilization": 0  # Not directly available through PyTorch
            })
    
    # Check for Apple Silicon MPS (Metal Performance Shaders)
    elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        devices.append({
            "index": 0,
            "name": "Apple Metal GPU",
            "memoryTotal": 0,  # Not directly available through PyTorch for MPS
            "memoryUsed": 0,
            "utilization": 0
        })
    
    return {
        "available": True,
        "count": len(devices),
        "devices": devices
    }

print(json.dumps(get_gpu_info()))
`
		);

		// Execute the script with the ComfyUI Python
		const result = await $`cd ${comfyuiPath} && ${pythonPath} ${scriptPath}`.text();

		// Clean up the temporary script
		await $`rm ${scriptPath}`.quiet();

		// Parse the JSON output
		const gpuInfo = JSON.parse(result.trim());
		return gpuInfo;
	} catch (error) {
		console.warn('Error fetching macOS GPU info:', error);
		return { available: false, count: 0, devices: [] };
	}
}

/**
 * Get system metrics on macOS
 */
async function getMacOSSystemMetrics(): Promise<SystemMetrics> {
	try {
		// Get CPU utilization (macOS specific top command format)
		const topOutput = await $`top -l 1 -n 0 | grep "CPU usage"`.text();
		const cpuMatch = topOutput.match(/(\d+\.\d+)% user, (\d+\.\d+)% sys/);
		const cpuUtilization = cpuMatch ? parseFloat(cpuMatch[1]) + parseFloat(cpuMatch[2]) : 0;

		// Get memory information using vm_stat and sysctl
		const vmStatOutput = await $`vm_stat | grep "Pages"`.text();

		// Extract active, wired, and compressed memory pages
		const activeMatch = vmStatOutput.match(/Pages active:\s+(\d+)/);
		const wiredMatch = vmStatOutput.match(/Pages wired down:\s+(\d+)/);
		const compressedMatch = vmStatOutput.match(/Pages occupied by compressor:\s+(\d+)/);

		// Get page size and physical memory
		const pageSize = parseInt((await $`sysctl -n hw.pagesize`.text()).trim()) / (1024 * 1024); // Convert to MB
		const totalMemory = parseInt((await $`sysctl -n hw.memsize`.text()).trim()) / (1024 * 1024); // Convert to MB

		// Calculate used memory
		const activeMem = activeMatch ? parseInt(activeMatch[1]) * pageSize : 0;
		const wiredMem = wiredMatch ? parseInt(wiredMatch[1]) * pageSize : 0;
		const compressedMem = compressedMatch ? parseInt(compressedMatch[1]) * pageSize : 0;

		const usedMemory = activeMem + wiredMem + compressedMem;

		return {
			cpuUtilization,
			ramUsed: Math.round(usedMemory),
			ramTotal: Math.round(totalMemory),
			ramUtilization: (usedMemory / totalMemory) * 100
		};
	} catch (error) {
		console.warn('Error fetching macOS system metrics:', error);
		return {
			cpuUtilization: 0,
			ramUsed: 0,
			ramTotal: 0,
			ramUtilization: 0
		};
	}
}

// ===================== WINDOWS IMPLEMENTATIONS =====================

/**
 * Get GPU information on Windows using nvidia-smi or Windows Management Instrumentation (WMI)
 */
async function getWindowsGPUInfo(): Promise<GPUInfo> {
	try {
		// First, try with nvidia-smi which might be available on Windows with NVIDIA GPUs
		try {
			const output =
				await $`nvidia-smi --query-gpu=index,name,temperature.gpu,fan.speed,power.draw,power.limit,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits`.text();

			if (output && output.trim() !== '') {
				const devices: GPUDevice[] = output
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

				return {
					available: devices.length > 0,
					count: devices.length,
					devices
				};
			}
		} catch (e) {
			// nvidia-smi failed, continue to WMI approach
		}

		// Fallback to Windows Management Instrumentation (WMI)
		const output =
			await $`powershell -Command "Get-WmiObject -Query 'SELECT * FROM Win32_VideoController' | ConvertTo-Json"`.text();
		const gpuData = JSON.parse(output);

		// Ensure we have an array, even if only one GPU is found
		const gpuArray = Array.isArray(gpuData) ? gpuData : [gpuData];

		const devices: GPUDevice[] = gpuArray.map((gpu, index) => ({
			index,
			name: gpu.Name,
			memoryTotal: gpu.AdapterRAM ? gpu.AdapterRAM / (1024 * 1024) : 0 // Convert to MB if available
		}));

		return {
			available: devices.length > 0,
			count: devices.length,
			devices
		};
	} catch (error) {
		console.warn('Error fetching Windows GPU info:', error);
		return { available: false, count: 0, devices: [] };
	}
}

/**
 * Get system metrics on Windows
 */
async function getWindowsSystemMetrics(): Promise<SystemMetrics> {
	try {
		// Get CPU utilization
		const cpuOutput =
			await $`powershell -Command "Get-WmiObject Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object -ExpandProperty Average"`.text();
		const cpuUtilization = parseFloat(cpuOutput.trim());

		// Get memory information
		const memOutput =
			await $`powershell -Command "Get-WmiObject -Class Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory | ConvertTo-Json"`.text();
		const memData = JSON.parse(memOutput);

		// Values are in KB, convert to MB
		const ramTotal = Math.round(memData.TotalVisibleMemorySize / 1024);
		const freeMemory = Math.round(memData.FreePhysicalMemory / 1024);
		const ramUsed = ramTotal - freeMemory;

		return {
			cpuUtilization,
			ramUsed,
			ramTotal,
			ramUtilization: (ramUsed / ramTotal) * 100
		};
	} catch (error) {
		console.warn('Error fetching Windows system metrics:', error);
		return {
			cpuUtilization: 0,
			ramUsed: 0,
			ramTotal: 0,
			ramUtilization: 0
		};
	}
}

// Get platform-specific environment variables
export function getPlatformEnv(options: ComfyUIOptions): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };

	if (isLinux || isWindows) {
		// CUDA environment variables for Linux and Windows
		if (options.cudaDevice !== undefined) {
			env.CUDA_VISIBLE_DEVICES = options.cudaDevice.toString();
		}
	}

	if (isMacOS) {
		// Metal/MPS environment variables for macOS
		if (options.useMps) {
			env.PYTORCH_ENABLE_MPS_FALLBACK = '1';
		}
	}

	return env;
}
