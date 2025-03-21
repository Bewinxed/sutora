// src/lib/utils/comfyuiCli.ts
import { $, type ShellPromise } from 'bun';
import { getPythonPath } from './pythonUtils';

// Define the interface for ComfyUI CLI options
export interface ComfyUIOptions {
	// Network options
	listen?: string;
	port?: number;
	tlsKeyfile?: string;
	tlsCertfile?: string;
	enableCorsHeader?: string;
	maxUploadSize?: number;

	// Directory options
	baseDirectory?: string;
	extraModelPathsConfig?: string[];
	outputDirectory?: string;
	tempDirectory?: string;
	inputDirectory?: string;
	userDirectory?: string;

	// Behavior options
	autoLaunch?: boolean;
	disableAutoLaunch?: boolean;

	// GPU/CUDA options
	cudaDevice?: number;
	cudaMalloc?: boolean;
	disableCudaMalloc?: boolean;

	// Precision options
	forceFp32?: boolean;
	forceFp16?: boolean;

	// UNet precision
	fp32Unet?: boolean;
	fp64Unet?: boolean;
	bf16Unet?: boolean;
	fp16Unet?: boolean;
	fp8E4m3fnUnet?: boolean;
	fp8E5m2Unet?: boolean;

	// VAE precision
	fp16Vae?: boolean;
	fp32Vae?: boolean;
	bf16Vae?: boolean;
	cpuVae?: boolean;

	// Text encoder precision
	fp8E4m3fnTextEnc?: boolean;
	fp8E5m2TextEnc?: boolean;
	fp16TextEnc?: boolean;
	fp32TextEnc?: boolean;

	// Memory layout
	forceChannelsLast?: boolean;

	// Other hardware options
	directml?: number;
	oneapiDeviceSelector?: string;
	disableIpexOptimize?: boolean;

	// Preview options
	previewMethod?: 'none' | 'auto' | 'latent2rgb' | 'taesd';
	previewSize?: number;

	// Cache options
	cacheClassic?: boolean;
	cacheLru?: number;

	// Attention mechanism
	useSplitCrossAttention?: boolean;
	useQuadCrossAttention?: boolean;
	usePytorchCrossAttention?: boolean;
	useSageAttention?: boolean;
	useFlashAttention?: boolean;
	disableXformers?: boolean;

	// Attention precision
	forceUpcastAttention?: boolean;
	dontUpcastAttention?: boolean;

	// VRAM management
	gpuOnly?: boolean;
	highvram?: boolean;
	normalvram?: boolean;
	lowvram?: boolean;
	novram?: boolean;
	cpu?: boolean;
	reserveVram?: number;
	disableSmartMemory?: boolean;

	// Other options
	defaultHashingFunction?: 'md5' | 'sha1' | 'sha256' | 'sha512';
	deterministic?: boolean;
	fast?: ('fp16_accumulation' | 'fp8_matrix_mult')[];
	dontPrintServer?: boolean;
	quickTestForCi?: boolean;
	windowsStandaloneBuild?: boolean;
	disableMetadata?: boolean;
	disableAllCustomNodes?: boolean;
	multiUser?: boolean;
	verbose?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
	logStdout?: boolean;
	frontEndVersion?: string;
	frontEndRoot?: string;
	enableCompressResponseBody?: boolean;
}

// Interface for instance management
export interface ComfyInstance {
	process: ShellPromise | null;
	port: number;
	gpuIndices: string;
	options: ComfyUIOptions;
	status: 'running' | 'stopped' | 'error';
	pid?: number;
}

// Helper function to convert camelCase to kebab-case
function toKebabCase(str: string): string {
	return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// Build command line arguments from options
export function buildArgs(options: ComfyUIOptions): string[] {
	const args: string[] = [];

	for (const [key, value] of Object.entries(options)) {
		if (value === undefined || value === false) continue;

		const kebabKey = toKebabCase(key);

		// Handle boolean flags
		if (value === true) {
			args.push(`--${kebabKey}`);
			continue;
		}

		// Handle array values
		if (Array.isArray(value)) {
			if (kebabKey === 'fast') {
				if (value.length === 0) {
					args.push(`--${kebabKey}`);
				} else {
					args.push(`--${kebabKey}`, ...value);
				}
			} else {
				for (const item of value) {
					args.push(`--${kebabKey}`, item.toString());
				}
			}
			continue;
		}

		// Handle other values
		args.push(`--${kebabKey}`, value.toString());
	}

	return args;
}

// Launch a ComfyUI instance
// Launch a ComfyUI instance
export async function launchComfyUI(
	comfyuiPath: string,
	options: ComfyUIOptions,
	onStdout?: (data: string) => void,
	onStderr?: (data: string) => void
): Promise<ComfyInstance> {
	const args = buildArgs(options);

	// Set environment variables for GPU selection
	const env = {
		...process.env,
		CUDA_VISIBLE_DEVICES:
			options.cudaDevice !== undefined ? options.cudaDevice.toString() : undefined
	};

	try {
		// Get the appropriate Python path
		const pythonPath = await getPythonPath(comfyuiPath);

		// Start the process using the appropriate Python path
		console.log(`Starting ComfyUI in ${comfyuiPath} with Python: ${pythonPath}`);

		const shellProcess = $`cd ${comfyuiPath} && ${pythonPath} main.py ${args.join(' ')}`
			.env(env as Record<string, string>)
			.nothrow();

		// Set up stdout and stderr handling
		if (onStdout) {
			for await (const line of shellProcess.lines()) {
				onStdout(line);
			}
		}

		if (onStderr) {
			shellProcess.catch((error) => {
				if (error.stderr) {
					onStderr(error.stderr.toString());
				}
			});
		}

		const instance: ComfyInstance = {
			process: shellProcess,
			port: options.port || 8188,
			gpuIndices: options.cudaDevice !== undefined ? options.cudaDevice.toString() : '',
			options,
			status: 'running'
		};

		return instance;
	} catch (error) {
		console.error('Error starting ComfyUI instance:', error);
		throw error;
	}
}

// Stop a ComfyUI instance - cross-platform compatible
export async function stopComfyInstance(instance: ComfyInstance): Promise<boolean> {
	if (!instance.process || instance.status !== 'running') {
		return false;
	}

	try {
		// For cross-platform compatibility, we need to terminate the process
		// ShellPromise doesn't have a direct kill method, but in Bun we can use
		// the underlying Node compatible process API

		// First, cancel any running command using .finally()
		instance.process.finally();

		// Then, set instance to stopped
		instance.status = 'stopped';
		instance.process = null;

		return true;
	} catch (error) {
		console.error('Error stopping ComfyUI instance:', error);
		return false;
	}
}
