// src/lib/utils/portUtils.ts
import { createServer } from 'node:net';

/**
 * Check if a port is available
 * @param port The port to check
 * @returns True if the port is available, false otherwise
 */
export async function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();

		server.once('error', () => {
			// Port is in use
			resolve(false);
		});

		server.once('listening', () => {
			// Port is available, close the server
			server.close(() => {
				resolve(true);
			});
		});

		server.listen(port);
	});
}

/**
 * Find the next available port starting from a base port
 * @param basePort The port to start checking from
 * @returns The next available port
 */
export async function findAvailablePort(basePort: number = 8188): Promise<number> {
	let port = basePort;
	while (!(await isPortAvailable(port))) {
		port++;
	}
	return port;
}
