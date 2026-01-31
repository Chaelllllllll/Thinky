const path = require('path');

// Ensure the working directory is the project root so server.js static paths work
process.chdir(path.join(__dirname, '..'));

let serverless = null;
try {
	serverless = require('serverless-http');
} catch (err) {
	console.error('serverless-http is not installed:', err && err.message ? err.message : err);
}

// Import the Express app and capture any require error for debugging
let app = null;
let requireError = null;
try {
	app = require('../server');
} catch (err) {
	requireError = err && err.message ? err.message : String(err);
	console.error('Failed to require server app:', requireError);
}

if (!serverless || !app) {
	// Export a minimal handler that returns 500 explaining the issue
	module.exports = async (req, res) => {
		res.statusCode = 500;
		res.setHeader('Content-Type', 'application/json');
		const detail = serverless ? 'app_load_failed' : 'serverless_http_missing';
		const payload = { error: 'Server misconfiguration', detail };
		if (requireError) payload.requireError = requireError;
		res.end(JSON.stringify(payload));
	};
} else {
	module.exports = serverless(app);
}
