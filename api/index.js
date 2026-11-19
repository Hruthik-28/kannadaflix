'use strict';

// Vercel serverless function. vercel.json rewrites every path (/manifest.json, /catalog/..., /meta/...) to it.
module.exports = require('../src/vercel').createHandler();
