'use strict';

// Vercel entry point: every request is rewritten here (see vercel.json) and handled by the Express app.
module.exports = require('../index.js').app;
