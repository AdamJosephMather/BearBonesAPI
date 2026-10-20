import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import express from 'express';
import { DUCK_TOKEN } from './secrets.js';
import * as canvas_interface from './CanvasInterface.js'

const app = express();
const PORT = 3982;

// For json in/out
app.use(express.json())

// --- CONFIGURATION ---
const DUCK_DOMAIN        = 'bearbones';
const SERVER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const SYNC_INTERVAL_MS   = 4 * 60 * 60 * 1000; // 4 hours

// Metadata tracking object
const serverState = {
	lastIpUpdate: 'Never',
	lastIpStatus: 'Initializing',
	lastCertCheck: 'Never',
	certReloadCount: 0,
	startTime: new Date().toISOString()
};

// Helper: Dynamically find Posh-ACME directory for your domain
function findCertPaths() {
	const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
	const poshAcmeDir = path.join(localAppData, 'Posh-ACME');

	function searchDir(dir) {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === `${DUCK_DOMAIN}.duckdns.org`) {
						return fullPath;
					}
					const found = searchDir(fullPath);
					if (found) return found;
				}
			}
		} catch (e) {
			// Ignore permission or missing folder errors during recursion
		}
		return null;
	}

	const certFolder = searchDir(poshAcmeDir);
	if (!certFolder) {
		throw new Error(`Could not locate Posh-ACME folder for ${DUCK_DOMAIN}.duckdns.org`);
	}

	return {
		cert: path.join(certFolder, 'fullchain.cer'),
		key: path.join(certFolder, 'cert.key')
	};
}

// Helper: Load initial certificates securely
function loadInitialCerts() {
	const paths = findCertPaths();
	return {
		key: fs.readFileSync(paths.key),
		cert: fs.readFileSync(paths.cert),
		mtime: fs.statSync(paths.key).mtimeMs,
		certMtime: fs.statSync(paths.cert).mtimeMs
	};
}

// Initialize HTTPS Server
let certData;
try {
	certData = loadInitialCerts();
	console.log('[SSL] Certificates successfully loaded on startup.');
} catch (err) {
	console.error('[SSL Error] Failed to load certificates on startup:', err.message);
	process.exit(1); // Exit if initial certs are missing
}

const server = https.createServer({
	key: certData.key,
	cert: certData.cert
}, app);

let lastKeyMtime = certData.mtime;
let lastCertMtime = certData.certMtime;

// --- ROUTES ---
app.get('/', (req, res) => {
	const clientIp = req.ip || req.socket.remoteAddress;
	res.send(`
		<html>
			<head><title>Bearbones API Server</title></head>
			<body style="font-family: Arial, sans-serif; padding: 40px;">
				<h1 style="color: #2bcb5c;">Port Forwarding Test Successful!</h1>
				<p>Connected securely to port <b>${PORT}</b>.</p>
				<p>Your incoming IP: <code>${clientIp}</code></p>
				<hr style="border: 0; border-top: 1px solid #ddd; margin: 20px 0;" />
				<h3>Server Metadata Status</h3>
				<ul>
					<li><b>Server Uptime Started:</b> ${serverState.startTime}</li>
					<li><b>Last DuckDNS Update:</b> ${serverState.lastIpUpdate} (${serverState.lastIpStatus})</li>
					<li><b>Cert Hot-Reloads:</b> ${serverState.certReloadCount}</li>
				</ul>
			</body>
		</html>
	`);
});

// 1. /sync endpoint (accepts token as string, returns JSON)
app.post('/sync', async (req, res) => {
	const { token } = req.body ?? {};

	// Basic validation to ensure a token was provided
	if (typeof token !== 'string' || !token.trim()) {
		return res.status(400).json({ error: 'Token is required' });
	}

	// TODO: Add your logic to verify the token here
	console.log('[API] Received sync request');
	
	let output = await canvas_interface.getClientSync(token);
	
	res.json(output);
});

// 2. /findit endpoint (Accepts state JSON, returns JSON)
app.post('/findit', (req, res) => {
	const stateData = req.body;

	// Basic validation to ensure state data isn't empty
	if (!stateData || Object.keys(stateData).length === 0) {
		return res.status(400).json({ error: 'State data is required' });
	}

	// TODO: Add your logic to process the state here
	console.log('[API] Received state update:', stateData);

	// Send back a JSON response
	res.json({
		status: 'success',
		message: 'State processed successfully',
		echoState: stateData
	});
});

// --- BACKGROUND MAINTENANCE LOOP (DuckDNS + Cert Hot-Reload) ---
async function backgroundTask() {
	// 1. DuckDNS Check (Wrapped in try/catch so a dead internet connection never crashes the app)
	try {
		const url = `https://www.duckdns.org/update?domains=${DUCK_DOMAIN}&token=${DUCK_TOKEN}&ip=`;
		const response = await fetch(url);
		const body = await response.text();
		
		serverState.lastIpUpdate = new Date().toISOString();
		if (body.includes('OK')) {
			serverState.lastIpStatus = 'SUCCESS (OK)';
			console.log(`[DuckDNS] ${serverState.lastIpUpdate} - IP updated successfully.`);
		} else {
			serverState.lastIpStatus = `FAILED (${body.trim()})`;
			console.warn(`[DuckDNS] Update rejected:`, body);
		}
	} catch (err) {
		serverState.lastIpUpdate = new Date().toISOString();
		serverState.lastIpStatus = `OFFLINE (${err.message})`;
		console.warn(`[DuckDNS] Network issue detected. Skipping this interval. Details:`, err.message);
	}

	// 2. Certificate Check & Hot-Reload
	try {
		serverState.lastCertCheck = new Date().toISOString();
		const paths = findCertPaths();
		const keyStat = fs.statSync(paths.key);
		const certStat = fs.statSync(paths.cert);

		if (keyStat.mtimeMs !== lastKeyMtime || certStat.mtimeMs !== lastCertMtime) {
			console.log('[SSL] New certificate modification detected. Hot-swapping...');
			
			server.setSecureContext({
				key: fs.readFileSync(paths.key),
				cert: fs.readFileSync(paths.cert)
			});
			
			lastKeyMtime = keyStat.mtimeMs;
			lastCertMtime = certStat.mtimeMs;
			serverState.certReloadCount++;
			console.log('[SSL] Certificates successfully reloaded live without restart.');
		}
	} catch (err) {
		console.warn('[SSL] Could not check/reload certificates:', err.message);
	}
}

async function syncToCanvas() {
	try {
		await canvas_interface.canvasSync();
	} catch (err) {
		console.error('Background Canvas sync failed:', err.message);
	}
}

// Start interval loop
setInterval(backgroundTask, SERVER_INTERVAL_MS);

await canvas_interface.start();
void syncToCanvas();

setInterval(syncToCanvas, SYNC_INTERVAL_MS); // does not start until 4 hours from now.

// Start listening
server.listen(PORT, '0.0.0.0', () => {
	console.log(`Secure server running live at https://bearbones.duckdns.org:${PORT}`);
});
