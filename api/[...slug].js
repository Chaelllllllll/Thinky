import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure the working directory is the project root so server.js static paths work
process.chdir(path.join(__dirname, '..'));

let serverless = null;
let app = null;
let importError = null;

try {
	const mod = await import('serverless-http');
	serverless = mod && (mod.default || mod);
} catch (err) {
	console.error('serverless-http is not installed:', err && err.message ? err.message : err);
}

try {
	const srv = await import('../server.js');
	app = srv && (srv.default || srv);
} catch (err) {
	importError = err && err.message ? err.message : String(err);
	console.error('Failed to import server app:', importError);
}

let handler = null;
if (!serverless || !app) {
	// Minimal handler that returns 500 explaining the issue
	handler = async (req, res) => {
		res.statusCode = 500;
		res.setHeader('Content-Type', 'application/json');
		const detail = serverless ? 'app_load_failed' : 'serverless_http_missing';
		const payload = { error: 'Server misconfiguration', detail };
		if (importError) payload.importError = importError;
		res.end(JSON.stringify(payload));
	};
} else {
	handler = serverless(app);
}

export default handler;
