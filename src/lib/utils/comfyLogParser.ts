// src/tests/integration/utils/comfyLogParser.ts

/**
 * Utility for parsing and analyzing ComfyUI log output
 */
export class ComfyLogParser {
	private logs: string[] = [];

	/**
	 * Add a log line to the parser
	 * @param logLine The log line to add
	 */
	public addLog(logLine: string): void {
		this.logs.push(logLine);
	}

	/**
	 * Add multiple log lines to the parser
	 * @param logLines The log lines to add
	 */
	public addLogs(logLines: string[]): void {
		this.logs.push(...logLines);
	}

	/**
	 * Clear all stored logs
	 */
	public clearLogs(): void {
		this.logs = [];
	}

	/**
	 * Check if the server has started based on log output
	 * @returns True if the server appears to be running
	 */
	public isServerRunning(): boolean {
		const serverReadyIndicators = [
			'Server running',
			'Running on',
			'Starting server',
			'ComfyUI server started',
			'Web UI available at',
			'localhost:',
			'Server listening',
			'ComfyUI startup time'
		];

		return this.logs.some((log) =>
			serverReadyIndicators.some((indicator) => log.includes(indicator))
		);
	}

	/**
	 * Get any model load errors from the logs
	 * @returns Array of model load error messages
	 */
	public getModelLoadErrors(): string[] {
		const modelErrors: string[] = [];

		// Look for model loading errors in the logs
		for (let i = 0; i < this.logs.length; i++) {
			const log = this.logs[i];

			if (log.includes('Error loading') && log.includes('model')) {
				modelErrors.push(log);
			} else if (log.includes('Failed to load')) {
				modelErrors.push(log);
			}
		}

		return modelErrors;
	}

	/**
	 * Get all warning messages from the logs
	 * @returns Array of warning messages
	 */
	public getWarnings(): string[] {
		return this.logs.filter(
			(log) => log.includes('WARNING') || log.includes('WARN') || log.includes('warning:')
		);
	}

	/**
	 * Get all error messages from the logs
	 * @returns Array of error messages
	 */
	public getErrors(): string[] {
		return this.logs.filter(
			(log) =>
				log.includes('ERROR') ||
				log.includes('error:') ||
				log.includes('Exception') ||
				log.includes('Traceback')
		);
	}

	/**
	 * Determine if CUDA/GPU acceleration is available from logs
	 * @returns Object indicating GPU availability
	 */
	public getGpuStatus(): { available: boolean; type: string | null; info: string | null } {
		const cudaAvailable = this.logs.some(
			(log) => log.includes('CUDA available') || log.includes('Using device: cuda')
		);

		if (cudaAvailable) {
			const cudaInfo = this.logs.find((log) => log.includes('CUDA device'));
			return { available: true, type: 'cuda', info: cudaInfo || null };
		}

		const mpsAvailable = this.logs.some(
			(log) =>
				log.includes('MPS available') ||
				log.includes('Using device: mps') ||
				log.includes('Metal Performance Shaders')
		);

		if (mpsAvailable) {
			const mpsInfo = this.logs.find((log) => log.includes('MPS device'));
			return { available: true, type: 'mps', info: mpsInfo || null };
		}

		const cpuOnly = this.logs.some(
			(log) =>
				log.includes('Using device: cpu') ||
				log.includes('CPU only') ||
				log.includes('No GPU acceleration available')
		);

		if (cpuOnly) {
			return { available: false, type: 'cpu', info: 'CPU only mode' };
		}

		return { available: false, type: null, info: null };
	}

	/**
	 * Get the port the server is running on from logs
	 * @returns The port number or null if not found
	 */
	public getServerPort(): number | null {
		for (const log of this.logs) {
			// Look for common patterns in log messages that indicate port
			const portMatch =
				log.match(/localhost:(\d+)/) ||
				log.match(/127\.0\.0\.1:(\d+)/) ||
				log.match(/Running on.*port (\d+)/);

			if (portMatch && portMatch[1]) {
				return parseInt(portMatch[1], 10);
			}
		}

		return null;
	}

	/**
	 * Get the full log as a single string
	 * @returns All logs joined with newlines
	 */
	public getFullLog(): string {
		return this.logs.join('\n');
	}
}
