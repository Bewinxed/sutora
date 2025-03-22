// src/lib/utils/pythonUtils.ts
import { Glob } from 'bun';
import { join } from 'path';
import { existsSync } from 'fs';
import { $ } from 'bun';
import { db } from '$lib/server/db';
import { envVars } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// Cache for Python paths
const pythonPathCache = new Map<string, string>();

/**
 * Find Python executable in a virtual environment
 * @param baseDir The base directory where ComfyUI is installed
 * @returns Path to Python executable or null if not found
 */
export async function findPythonInVenv(baseDir: string): Promise<string | null> {
	const isWindows = process.platform === 'win32';
	const pythonExe = isWindows ? 'python.exe' : 'python';

	// Create glob patterns for virtual environments
	// Common venv locations: venv/, .venv/, env/, .env/
	const venvGlob = new Glob(`{venv,.venv,env,.env}/{bin,Scripts}/${pythonExe}`);

	try {
		// Scan for Python executables
		for await (const match of venvGlob.scan({
			cwd: baseDir,
			onlyFiles: true,
			absolute: true,
			followSymlinks: true
		})) {
			if (existsSync(match)) {
				return match;
			}
		}

		// If not found in standard venv locations, check for a conda environment
		// Only check if conda_env directory exists to avoid errors
		const condaEnvPath = join(baseDir, 'conda_env');
		if (existsSync(condaEnvPath)) {
			const condaGlob = new Glob(`**/python{,.exe}`);
			for await (const match of condaGlob.scan({
				cwd: condaEnvPath,
				onlyFiles: true,
				absolute: true,
				followSymlinks: true,
				dot: true
			})) {
				if (existsSync(match)) {
					return match;
				}
			}
		}

		return null;
	} catch (error) {
		console.error('Error finding Python in venv:', error);
		return null;
	}
}

/**
 * Find system-wide Python
 * @returns Path to system Python or "python" if not found
 */
export async function findSystemPython(): Promise<string> {
	try {
		const isWindows = process.platform === 'win32';

		// Use where/which to find Python in PATH
		const cmd = isWindows ? 'where' : 'which';
		const pythonCmd = isWindows ? 'python' : 'python3';

		const result = await $`${cmd} ${pythonCmd}`.text();
		const pythonPath = result.trim().split('\n')[0];

		return pythonPath || (isWindows ? 'python' : 'python3');
	} catch (error) {
		console.warn("Couldn't find system Python, defaulting to 'python':", error);
		return 'python';
	}
}

/**
 * Validate a Python executable
 * @param pythonPath Path to Python executable
 * @returns Object with validation result
 */
export async function validatePython(pythonPath: string): Promise<{
	valid: boolean;
	version?: string;
	error?: string;
}> {
	try {
		const versionOutput = await $`${pythonPath} --version`.text();

		if (!versionOutput.toLowerCase().includes('python')) {
			return { valid: false, error: 'Not a Python executable' };
		}

		return {
			valid: true,
			version: versionOutput.trim()
		};
	} catch (error) {
		return {
			valid: false,
			error: String(error)
		};
	}
}

/**
 * Get the Python path from settings or detect it
 * @param comfyuiPath Path to ComfyUI installation
 * @returns Path to Python executable
 */
export async function getPythonPath(comfyuiPath: string): Promise<string> {
	// Check cache first
	if (pythonPathCache.has(comfyuiPath)) {
		return pythonPathCache.get(comfyuiPath)!;
	}

	// First, check if we have a custom Python path in the database
	const pythonPathResult = await db.select().from(envVars).where(eq(envVars.key, 'PYTHON_PATH'));

	if (pythonPathResult.length > 0 && pythonPathResult[0].value) {
		// Use the custom Python path from the database
		const pythonPath = pythonPathResult[0].value;

		// Validate the path
		const validation = await validatePython(pythonPath);
		if (validation.valid) {
			console.log(`Using configured Python path: ${pythonPath} (${validation.version})`);
			pythonPathCache.set(comfyuiPath, pythonPath);
			return pythonPath;
		}

		console.warn(`Configured Python path is invalid: ${pythonPath}. Error: ${validation.error}`);
	}

	// Try to detect a virtual environment
	const venvPython = await findPythonInVenv(comfyuiPath);
	if (venvPython) {
		const validation = await validatePython(venvPython);
		if (validation.valid) {
			console.log(`Using detected Python venv: ${venvPython} (${validation.version})`);

			// Store the detected path for future use
			await db
				.insert(envVars)
				.values({
					key: 'PYTHON_PATH',
					value: venvPython,
					description: `Automatically detected virtual environment (${validation.version})`,
					updatedAt: new Date()
				})
				.onConflictDoUpdate({
					target: envVars.key,
					set: {
						value: venvPython,
						description: `Automatically detected virtual environment (${validation.version})`,
						updatedAt: new Date()
					}
				});

			pythonPathCache.set(comfyuiPath, venvPython);
			return venvPython;
		}
	}

	// Fall back to system Python
	const systemPython = await findSystemPython();
	console.warn(
		`No valid Python virtual environment detected. Using system Python: ${systemPython}`
	);

	pythonPathCache.set(comfyuiPath, systemPython);
	return systemPython;
}

/**
 * Clear the Python path cache
 */
export function clearPythonPathCache(): void {
	pythonPathCache.clear();
}
