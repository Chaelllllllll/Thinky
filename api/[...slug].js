const serverless = require('serverless-http');
const path = require('path');

// Ensure the working directory is the project root so server.js static paths work
process.chdir(path.join(__dirname, '..'));

// Import the Express app
const app = require('../server');

module.exports = serverless(app);
