/**
 * A deliberately small Express work-alike used only by the test suite.
 *
 * Why this exists: this sandbox cannot reach the npm registry, so `express`
 * cannot be installed here. Rather than skip route testing, this stub
 * implements exactly the Express surface server.js uses (app.use/get/post/
 * put/delete, :params, RegExp paths, next(), 4-arg error handlers, res.status/
 * json/send/sendFile) so the real route handlers can be exercised over real
 * HTTP against real storage modules.
 *
 * It is NOT a general Express replacement. If server.js starts using a feature
 * not implemented here, the stub should grow — or the test should run against
 * the real package on a machine with registry access.
 */

'use strict';

const { URL } = require('node:url');

function compilePath(path) {
  if (path instanceof RegExp) {
    return { regex: path, keys: [] };
  }

  const keys = [];
  const pattern = String(path)
    .replace(/\/+$/, '') // tolerate a trailing slash in definitions
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex chars...
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });

  return { regex: new RegExp(`^${pattern || '/'}/?$`), keys };
}

function createResponse(res) {
  res.statusCode = 200;
  res.headers = {};
  res._sent = false;

  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
    return res;
  };
  res.getHeader = (name) => res.headers[name.toLowerCase()];
  res.type = (value) => {
    res.setHeader('content-type', value);
    return res;
  };

  const finish = () => {
    res._sent = true;
  };

  res.json = (payload) => {
    finish();
    const body = JSON.stringify(payload);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res._body = body;
    realWrite(res, body);
    return res;
  };

  res.send = (payload) => {
    finish();
    res._body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    realWrite(res, res._body);
    return res;
  };

  res.sendFile = (filePath, callback) => {
    finish();
    const fs = require('node:fs');
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        if (callback) return callback(err);
        res.statusCode = 500;
        return realWrite(res, 'sendFile failed');
      }
      res._body = buf;
      realWrite(res, buf);
      if (callback) callback();
    });
    return res;
  };

  return res;
}

function realWrite(res, body) {
  if (!res._raw) return; // e.g. a body-less unit call
  try {
    if (!res.headersSent) {
      for (const [k, v] of Object.entries(res.headers)) res._raw.setHeader(k, v);
      res._raw.statusCode = res.statusCode;
    }
    res._raw.end(typeof body === 'string' ? body : Buffer.from(body || ''));
  } catch { /* connection already closed */ }
}

function createApp() {
  const stack = [];

  const register = (method, path, handlers) => {
    const { regex, keys } = compilePath(path);
    stack.push({ kind: 'route', method, regex, keys, handlers });
  };

  const app = (req, res) => {
    // Normalise onto the raw Node response for writes, but keep our helpers.
    const response = createResponse(res);
    response._raw = res;

    const parsed = new URL(req.url || '/', 'http://localhost');
    const pathname = decodeURIComponent(parsed.pathname);
    const query = Object.fromEntries(parsed.searchParams.entries());

    req.query = query;
    req.params = {};
    req.body = req.body === undefined ? {} : req.body;
    req.path = pathname;

    let index = 0;

    const next = (err) => {
      if (index >= stack.length) {
        if (err) {
          response.statusCode = 500;
          return response.json({ error: 'Unhandled error in stub' });
        }
        if (!res.writableEnded && !response._sent) {
          response.statusCode = 404;
          return response.send('Not Found');
        }
        return undefined;
      }

      const layer = stack[index++];

      if (layer.kind === 'middleware') {
        // Error handlers are identified by their FUNCTION arity (err, req, res,
        // next), not by how many handlers were registered for the layer.
        const arity = layer.handlers[0] ? layer.handlers[0].length : 0;
        if (err && arity < 4) return next(err);
        if (!err && arity >= 4) return next();
        return invoke(layer, req, response, next, err);
      }

      if (err) return next(err);
      if (layer.method !== req.method) return next();

      const match = layer.regex.exec(pathname);
      if (!match) return next();

      req.params = {};
      layer.keys.forEach((key, i) => {
        req.params[key] = match[i + 1];
      });
      req.route = { path: layer.regex };
      return invoke(layer, req, response, next);
    };

    next();
  };

  function invoke(layer, req, res, next, err) {
    if (err) {
      const handler = layer.handlers[layer.handlers.length - 1];
      return handler(err, req, res, next);
    }

    let i = 0;
    const step = (e) => {
      // Continue from the current position. Rewinding the index here would
      // re-enter already-run middleware (and hang on an exhausted body stream).
      if (e) return next(e);
      if (i >= layer.handlers.length) return next();
      const handler = layer.handlers[i++];
      try {
        const out = handler(req, res, step);
        if (out && typeof out.catch === 'function') out.catch(step);
      } catch (e2) {
        step(e2);
      }
      return undefined;
    };
    return step();
  }

  app.use = (pathOrHandler, maybeHandler) => {
    const path = typeof pathOrHandler === 'function' ? '/' : pathOrHandler;
    const handler = typeof pathOrHandler === 'function' ? pathOrHandler : maybeHandler;
    const { regex, keys } = compilePath(path);
    stack.push({ kind: 'middleware', method: null, regex, keys, handlers: [handler] });
    return app;
  };

  app.get = (path, ...handlers) => { register('GET', path, handlers); return app; };
  app.post = (path, ...handlers) => { register('POST', path, handlers); return app; };
  app.put = (path, ...handlers) => { register('PUT', path, handlers); return app; };
  app.delete = (path, ...handlers) => { register('DELETE', path, handlers); return app; };
  app.patch = (path, ...handlers) => { register('PATCH', path, handlers); return app; };

  app.set = () => app;
  app.disable = () => app;
  app.enable = () => app;

  return app;
}

/** express.json() stand-in: parses the body into req.body. */
function json() {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      req.body = {};
      return next();
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        req.body = {};
        return next();
      }
      try {
        req.body = JSON.parse(raw);
        return next();
      } catch (e) {
        const err = new SyntaxError('Unexpected token in JSON');
        err.body = raw;
        err.status = 400;
        return next(err);
      }
    });
    return undefined;
  };
}

/** express.static() stand-in: no-op, since static files are served by the CDN in prod. */
function staticMiddleware() {
  return (req, res, next) => next();
}

/** cors() stand-in. */
function cors() {
  return (req, res, next) => next();
}

const express = Object.assign(() => createApp(), { json, static: staticMiddleware, Router: createApp });
express.cors = cors;

module.exports = express;
module.exports.__createApp = createApp;
