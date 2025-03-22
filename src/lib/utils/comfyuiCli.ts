// src/lib/utils/comfyuiCli.ts
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { $, type ShellPromise } from 'bun';
import { getPythonPath } from './pythonUtils';
import { getPlatformEnv, isLinux, isMacOS, isWindows } from './platformUtils';

// Set reasonable default timeouts that can be overridden
const DEFAULT_API_TIMEOUT = 5000;
const DEFAULT_STARTUP_TIMEOUT = 120000;
const DEFAULT_CHECK_INTERVAL = 3000;

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

	// macOS specific options
	useMps?: boolean; // Use Metal Performance Shaders on Apple Silicon

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

// Interface for ComfyUI workflow prompt
export interface ComfyUIPrompt {
	[key: string]: {
		class_type: string;
		inputs: Record<string, any>;
	};
}

// Interface for instance management
export interface ComfyInstance {
	id: string;
	process: ChildProcess | null;
	port: number;
	host: string;
	gpuIndices: string;
	options: ComfyUIOptions;
	status: 'running' | 'starting' | 'stopped' | 'error';
	pid?: number;
	logs: string[];
	errors: string[];
	warnings: string[];
	lastError?: string;
	startTime?: Date;
}

// Default workflow for testing
export const DEFAULT_WORKFLOW: ComfyUIPrompt = {
	'3': {
		class_type: 'KSampler',
		inputs: {
			cfg: 8,
			denoise: 1,
			latent_image: ['5', 0],
			model: ['4', 0],
			negative: ['7', 0],
			positive: ['6', 0],
			sampler_name: 'euler',
			scheduler: 'normal',
			seed: 8566257,
			steps: 20
		}
	},
	'4': {
		class_type: 'CheckpointLoaderSimple',
		inputs: {
			ckpt_name: 'v1-5-pruned-emaonly.safetensors'
		}
	},
	'5': {
		class_type: 'EmptyLatentImage',
		inputs: {
			batch_size: 1,
			height: 512,
			width: 512
		}
	},
	'6': {
		class_type: 'CLIPTextEncode',
		inputs: {
			clip: ['4', 1],
			text: 'masterpiece best quality girl'
		}
	},
	'7': {
		class_type: 'CLIPTextEncode',
		inputs: {
			clip: ['4', 1],
			text: 'bad hands'
		}
	},
	'8': {
		class_type: 'VAEDecode',
		inputs: {
			samples: ['3', 0],
			vae: ['4', 2]
		}
	},
	'9': {
		class_type: 'SaveImage',
		inputs: {
			filename_prefix: 'ComfyUI',
			images: ['8', 0]
		}
	}
};

export class ComfyUICli {
	private pythonPath: string | null = null;
	private comfyuiPath: string;
	private instances: Map<string, ComfyInstance> = new Map();
	private initialized: boolean = false;
	private debug: boolean = false;

	// Configuration options with environment variable overrides
	private apiTimeout: number = parseInt(
		process.env.COMFY_API_TIMEOUT || `${DEFAULT_API_TIMEOUT}`,
		10
	);
	private startupTimeout: number = parseInt(
		process.env.COMFY_STARTUP_TIMEOUT || `${DEFAULT_STARTUP_TIMEOUT}`,
		10
	);
	private checkInterval: number = parseInt(
		process.env.COMFY_CHECK_INTERVAL || `${DEFAULT_CHECK_INTERVAL}`,
		10
	);

	constructor(comfyuiPath: string, options?: { debug?: boolean }) {
		this.comfyuiPath = comfyuiPath;
		this.debug = options?.debug || false;
	}

	/**
	 * Enable or disable debug mode
	 */
	public setDebug(debug: boolean): void {
		this.debug = debug;
	}

	/**
	 * Log messages when in debug mode
	 */
	private debugLog(...args: any[]): void {
		if (this.debug) {
			console.log('[ComfyUICli]', ...args);
		}
	}

	/**
	 * Initialize the CLI with the correct Python path
	 */
	public async initialize(): Promise<string> {
		if (this.initialized && this.pythonPath) {
			return this.pythonPath;
		}

		try {
			this.pythonPath = await getPythonPath(this.comfyuiPath);
			this.debugLog(`Using Python path: ${this.pythonPath}`);
			this.initialized = true;
			return this.pythonPath;
		} catch (error) {
			console.error('Failed to get Python path:', error);
			throw error;
		}
	}

	/**
	 * Get the cached Python path or initialize if not available
	 */
	public async getPythonPath(): Promise<string> {
		if (!this.pythonPath || !this.initialized) {
			return await this.initialize();
		}
		return this.pythonPath;
	}

	/**
	 * Helper function to convert camelCase to kebab-case
	 */
	private toKebabCase(str: string): string {
		return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
	}

	/**
	 * Build command line arguments from options
	 */
	public buildArgs(options: ComfyUIOptions): string[] {
		const args: string[] = [];

		for (const [key, value] of Object.entries(options)) {
			// Skip internal options that don't map to CLI arguments
			if (key === 'cudaDevice' || key === 'useMps') continue;

			if (value === undefined || value === false) continue;

			const kebabKey = this.toKebabCase(key);

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

	/**
	 * Create a modified workflow based on the default template
	 */
	public createWorkflow({
		positivePrompt = 'masterpiece best quality',
		negativePrompt = 'bad hands',
		seed = Math.floor(Math.random() * 1000000),
		steps = 20,
		cfg = 8,
		width = 512,
		height = 512,
		samplerName = 'euler',
		scheduler = 'normal',
		filenamePrefix = 'ComfyUI'
	}: {
		positivePrompt?: string;
		negativePrompt?: string;
		seed?: number;
		steps?: number;
		cfg?: number;
		width?: number;
		height?: number;
		samplerName?: string;
		scheduler?: string;
		filenamePrefix?: string;
	} = {}): ComfyUIPrompt {
		// Create a deep copy of the default workflow
		const workflow = JSON.parse(JSON.stringify(DEFAULT_WORKFLOW)) as ComfyUIPrompt;

		// Update parameters
		workflow['6'].inputs.text = positivePrompt;
		workflow['7'].inputs.text = negativePrompt;
		workflow['3'].inputs.seed = seed;
		workflow['3'].inputs.steps = steps;
		workflow['3'].inputs.cfg = cfg;
		workflow['3'].inputs.sampler_name = samplerName;
		workflow['3'].inputs.scheduler = scheduler;
		workflow['5'].inputs.width = width;
		workflow['5'].inputs.height = height;
		workflow['9'].inputs.filename_prefix = filenamePrefix;

		return workflow;
	}

	/**
	 * Launch a ComfyUI instance
	 */
	public async launchInstance(
		instanceId: string,
		options: ComfyUIOptions,
		onStdout?: (data: string) => void,
		onStderr?: (data: string) => void
	): Promise<ComfyInstance> {
		// Make sure Python path is initialized
		if (!this.pythonPath) {
			await this.initialize();
		}

		const args = this.buildArgs(options);

		this.debugLog(`Starting ComfyUI with arguments:`, args);

		// Set platform-specific environment variables
		const env = getPlatformEnv(options);

		const host = options.listen || '127.0.0.1';

		try {
			this.debugLog(`Starting ComfyUI in ${this.comfyuiPath} with Python: ${this.pythonPath}`);

			// Create instance object with logs storage
			const instance: ComfyInstance = {
				id: instanceId,
				process: null,
				port: options.port || 8188,
				host,
				gpuIndices: '',
				options,
				status: 'starting',
				logs: [],
				errors: [],
				warnings: [],
				startTime: new Date()
			};

			// For process control, still use spawn directly rather than Bun's shell
			// This is because we need direct process control for proper stdin/stdout handling
			const process = spawn(this.pythonPath!, ['main.py', ...args], {
				cwd: this.comfyuiPath,
				env: { ...process.env, ...env },
				stdio: ['ignore', 'pipe', 'pipe']
			});

			instance.process = process;
			instance.pid = process.pid;

			// Set up stdout and stderr handling
			if (process.stdout) {
				process.stdout.on('data', (data) => {
					const lines = data.toString().trim().split('\n');

					for (const line of lines) {
						if (!line) continue;

						instance.logs.push(line);

						// Categorize logs
						if (
							line.includes('ERROR') ||
							line.includes('error:') ||
							line.includes('Exception') ||
							line.includes('Traceback')
						) {
							instance.errors.push(line);
							this.debugLog(`ERROR: ${line}`);
						} else if (
							line.includes('WARNING') ||
							line.includes('WARN') ||
							line.includes('warning:')
						) {
							instance.warnings.push(line);
							this.debugLog(`WARNING: ${line}`);
						} else {
							this.debugLog(`LOG: ${line}`);
						}

						if (onStdout) {
							onStdout(line);
						}
					}
				});
			}

			if (process.stderr) {
				process.stderr.on('data', (data) => {
					const lines = data.toString().trim().split('\n');

					for (const line of lines) {
						if (!line) continue;

						instance.logs.push(line);
						instance.errors.push(line);

						this.debugLog(`STDERR: ${line}`);

						if (onStderr) {
							onStderr(line);
						}
					}
				});
			}

			// Handle process exit
			process.on('exit', (code, signal) => {
				this.debugLog(`ComfyUI process exited with code ${code} and signal ${signal}`);

				if (code !== 0 && code !== null) {
					instance.status = 'error';
					instance.lastError = `Process exited with code ${code}`;
				} else if (signal) {
					instance.status = 'stopped';
				} else {
					instance.status = 'stopped';
				}

				instance.process = null;
			});

			// Handle errors
			process.on('error', (error) => {
				this.debugLog(`ComfyUI process error:`, error);
				instance.status = 'error';
				instance.lastError = error.message;
				instance.errors.push(`Process error: ${error.message}`);
			});

			// Determine GPU indices based on platform
			if (options.cudaDevice !== undefined) {
				instance.gpuIndices = options.cudaDevice.toString();
			} else if (isMacOS && options.useMps) {
				instance.gpuIndices = 'mps';
			} else {
				instance.gpuIndices = 'cpu';
			}

			// Store the instance for future reference
			this.instances.set(instanceId, instance);

			// Update status to running
			instance.status = 'running';

			return instance;
		} catch (error) {
			console.error('Error starting ComfyUI instance:', error);
			throw error;
		}
	}

	/**
	 * Check if the process is actually running
	 */
	private async isProcessRunning(pid: number): Promise<boolean> {
		try {
			if (isWindows) {
				// On Windows, use tasklist with Bun's shell
				const result = await $`tasklist /FI "PID eq ${pid}" /NH`.nothrow().quiet();
				return (await result.text()).includes(pid.toString());
			} else {
				// On Unix-like systems (Linux/macOS), use ps with Bun's shell
				const result = await $`ps -p ${pid} -o pid=`.nothrow().quiet();
				return result.exitCode === 0;
			}
		} catch (error) {
			this.debugLog(`Error checking if process ${pid} is running:`, error);
			return false;
		}
	}

	/**
	 * Stop a ComfyUI instance
	 */
	public async stopInstance(instanceId: string): Promise<boolean> {
		const instance = this.instances.get(instanceId);

		if (!instance) {
			this.debugLog(`Instance ${instanceId} not found`);
			return false;
		}

		if (!instance.pid) {
			this.debugLog(`Instance ${instanceId} has no PID`);
			return false;
		}

		try {
			this.debugLog(`Stopping instance ${instanceId} (PID: ${instance.pid})`);

			// Try to terminate the process using the appropriate platform-specific command
			// Use Bun's shell for these commands
			let killed = false;

			if (isWindows) {
				// Windows - use taskkill
				try {
					await $`taskkill /pid ${instance.pid} /T /F`.quiet();
					killed = true;
				} catch (err) {
					this.debugLog(`Error using taskkill: ${err}`);
				}
			} else if (isLinux || isMacOS) {
				// Linux/macOS - first try SIGTERM
				try {
					await $`kill -TERM ${instance.pid}`.quiet();

					// Wait up to 5 seconds for process to terminate
					for (let i = 0; i < 10; i++) {
						const isRunning = await this.isProcessRunning(instance.pid);
						if (!isRunning) {
							killed = true;
							break;
						}
						await new Promise((resolve) => setTimeout(resolve, 500));
					}

					// If still running, try SIGKILL
					if (!killed) {
						await $`kill -KILL ${instance.pid}`.quiet();
						killed = true;
					}
				} catch (err) {
					this.debugLog(`Error killing process: ${err}`);
				}
			}

			// If the process still has a reference in our instance object, clean it up
			if (instance.process) {
				try {
					instance.process.kill();
				} catch (err) {
					// Ignore errors here
				}
			}

			// Update instance status
			instance.status = 'stopped';
			instance.process = null;

			this.debugLog(
				`Instance ${instanceId} ${killed ? 'stopped successfully' : 'could not be fully terminated'}`
			);
			return killed;
		} catch (error) {
			console.error(`Error stopping ComfyUI instance ${instanceId}:`, error);
			return false;
		}
	}

	/**
	 * Queue a prompt in ComfyUI
	 */
	public async queuePrompt(instanceId: string, prompt: ComfyUIPrompt): Promise<any> {
		const instance = this.instances.get(instanceId);

		if (!instance) {
			throw new Error(`Instance ${instanceId} not found`);
		}

		if (instance.status !== 'running') {
			throw new Error(`Instance ${instanceId} is not running`);
		}

		const apiUrl = `http://${instance.host}:${instance.port}`;
		const url = `${apiUrl}/prompt`;

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), this.apiTimeout);

			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(prompt),
					signal: controller.signal
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`ComfyUI API error (${response.status}): ${errorText}`);
				}

				return await response.json();
			} finally {
				clearTimeout(timeoutId);
			}
		} catch (error) {
			if (error.name === 'AbortError') {
				throw new Error(`ComfyUI API request timed out after ${this.apiTimeout}ms`);
			}
			throw error;
		}
	}

	/**
	 * Get system stats from ComfyUI instance
	 */
	public async getSystemStats(instanceId: string): Promise<any> {
		const instance = this.instances.get(instanceId);

		if (!instance) {
			throw new Error(`Instance ${instanceId} not found`);
		}

		const apiUrl = `http://${instance.host}:${instance.port}`;
		const url = `${apiUrl}/system_stats`;

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), this.apiTimeout);

			try {
				const response = await fetch(url, {
					method: 'GET',
					signal: controller.signal
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`ComfyUI API error (${response.status}): ${errorText}`);
				}

				return await response.json();
			} finally {
				clearTimeout(timeoutId);
			}
		} catch (error) {
			if (error.name === 'AbortError') {
				throw new Error(`ComfyUI API request timed out after ${this.apiTimeout}ms`);
			}
			throw error;
		}
	}

	/**
	 * Check if a ComfyUI instance API is responding
	 */
	public async isApiReady(instanceId: string): Promise<boolean> {
		const instance = this.instances.get(instanceId);

		if (!instance) {
			this.debugLog(`Instance ${instanceId} not found when checking API readiness`);
			return false;
		}

		// List of endpoints to check in order of preference
		const endpoints = ['/system_stats', '/prompt', '/'];

		for (const endpoint of endpoints) {
			try {
				const url = `http://${instance.host}:${instance.port}${endpoint}`;
				this.debugLog(`Checking API readiness at ${url}`);

				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), this.apiTimeout);

				try {
					const response = await fetch(url, {
						method: 'GET',
						signal: controller.signal
					});

					if (response.ok) {
						this.debugLog(`API is ready at ${url}`);
						return true;
					}

					this.debugLog(`API check failed at ${url} with status ${response.status}`);
				} finally {
					clearTimeout(timeoutId);
				}
			} catch (error) {
				this.debugLog(`API check error at ${endpoint}: ${error.message}`);
			}
		}

		return false;
	}

	/**
	 * Check if a ComfyUI instance is running and ready to accept requests
	 */
	public async isInstanceReady(
		instanceId: string,
		maxAttempts?: number,
		checkInterval?: number
	): Promise<{ ready: boolean; status: string }> {
		// Use values from parameters or fallback to configured values
		const attempts = maxAttempts || Math.ceil(this.startupTimeout / this.checkInterval);
		const interval = checkInterval || this.checkInterval;

		this.debugLog(`Checking ComfyUI readiness with ${attempts} attempts, ${interval}ms interval`);

		const instance = this.instances.get(instanceId);

		if (!instance) {
			return { ready: false, status: 'not_found' };
		}

		if (instance.status === 'stopped' || instance.status === 'error') {
			return { ready: false, status: instance.status };
		}

		// Check process and API readiness
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (attempt % 5 === 0) {
				this.debugLog(
					`ComfyUI health check attempt ${attempt + 1}/${attempts} for instance ${instanceId}`
				);
			}

			// First verify the process is running
			if (instance.pid) {
				const processRunning = await this.isProcessRunning(instance.pid);
				if (!processRunning) {
					instance.status = 'error';
					instance.lastError = 'Process not running';
					return { ready: false, status: 'error' };
				}
			}

			// Then check if the API is responding
			const apiReady = await this.isApiReady(instanceId);
			if (apiReady) {
				this.debugLog(`API is ready for instance ${instanceId}`);
				return { ready: true, status: 'running' };
			}

			// Check for fatal errors in logs
			const hasFatalErrors = instance.errors.some(
				(err) =>
					err.includes('Error: Cannot find module') ||
					err.includes('ModuleNotFoundError') ||
					err.includes('Fatal error') ||
					err.includes('Could not find model')
			);

			if (hasFatalErrors) {
				instance.status = 'error';
				return { ready: false, status: 'error' };
			}

			// Wait before next attempt if not the last one
			if (attempt < attempts - 1) {
				await new Promise((resolve) => setTimeout(resolve, interval));
			}
		}

		// If we reach here, the API never became ready
		// However, we'll check if the process is still running
		if (instance.pid && (await this.isProcessRunning(instance.pid))) {
			this.debugLog(`Instance ${instanceId} process is running but API is not ready`);
			// Process is running but API isn't responding
			return { ready: false, status: 'starting' };
		} else {
			instance.status = 'error';
			instance.lastError = 'Process exited or API never became ready';
			return { ready: false, status: 'error' };
		}
	}

	/**
	 * Get the ComfyUI instance if it exists
	 */
	public getInstance(instanceId: string): ComfyInstance | undefined {
		return this.instances.get(instanceId);
	}

	/**
	 * Get all ComfyUI instances
	 */
	public getAllInstances(): Map<string, ComfyInstance> {
		return this.instances;
	}

	/**
	 * Get all errors from an instance
	 */
	public getInstanceErrors(instanceId: string): string[] {
		const instance = this.instances.get(instanceId);
		if (!instance) {
			return [];
		}
		return instance.errors;
	}

	/**
	 * Get all warnings from an instance
	 */
	public getInstanceWarnings(instanceId: string): string[] {
		const instance = this.instances.get(instanceId);
		if (!instance) {
			return [];
		}
		return instance.warnings;
	}

	/**
	 * Get recent logs from an instance
	 */
	public getInstanceLogs(instanceId: string, limit: number = 50): string[] {
		const instance = this.instances.get(instanceId);
		if (!instance) {
			return [];
		}
		return instance.logs.slice(-limit);
	}
}

// Export static methods for backward compatibility
export async function launchComfyUI(
	comfyuiPath: string,
	options: ComfyUIOptions,
	onStdout?: (data: string) => void,
	onStderr?: (data: string) => void
): Promise<ComfyInstance> {
	const cli = new ComfyUICli(comfyuiPath);
	await cli.initialize();
	return cli.launchInstance('default', options, onStdout, onStderr);
}

export async function isComfyUIReady(
	instance: ComfyInstance,
	maxAttempts?: number,
	checkInterval?: number
): Promise<{ ready: boolean; status: string }> {
	const cli = new ComfyUICli('');
	return cli.isInstanceReady(instance.id, maxAttempts, checkInterval);
}

export async function stopComfyInstance(instance: ComfyInstance): Promise<boolean> {
	const cli = new ComfyUICli('');
	return cli.stopInstance(instance.id);
}
