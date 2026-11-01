'use strict';

/** Minimal cors() stand-in for tests — CORS headers are irrelevant to route logic. */
module.exports = function cors() {
  return (req, res, next) => next();
};
