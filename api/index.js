/**
 * Vercel serverless entry point.
 *
 * Vercel looks for files under /api and turns each one into a function. This
 * file simply hands every request to the same Express app that `npm start`
 * boots locally, so there is exactly one set of route definitions.
 *
 * vercel.json rewrites /api/(.*) here. Everything else (index.html, admin.html,
 * /images/*) is served statically from /public by Vercel's CDN, which is why
 * the Express static middleware never runs in production.
 */

'use strict';

const app = require('../server');

module.exports = function handler(req, res) {
  // Belt and braces: depending on routing, Vercel can hand the function either
  // the original path (/api/shipments) or a prefix-stripped one (/shipments).
  // Express only knows the first form, so restore the prefix when it is absent.
  const url = req.url || '/';
  if (!/^\/api(\/|$|\?)/.test(url)) {
    req.url = '/api' + (url.startsWith('/') ? url : `/${url}`);
  }

  return app(req, res);
};
