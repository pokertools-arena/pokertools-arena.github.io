'use strict';

// @pokertools/engine/browser injects Web Crypto as its randomProvider, so its
// Node-only getSecureRandom() path should never be used in the browser. The
// published engine still contains a static require("crypto") in deck.js,
// however, which browser bundlers must resolve. This tiny compatibility shim
// keeps the bundle browser-only and also provides randomBytes if that dead path
// is ever reached by a future engine change.
exports.randomBytes = function randomBytes(size) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('[pokertools-arena] Web Crypto API is required for secure browser RNG.');
  }
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  bytes.readUInt32BE = function readUInt32BE(offset = 0) {
    return (((this[offset] << 24) >>> 0) + (this[offset + 1] << 16) + (this[offset + 2] << 8) + this[offset + 3]) >>> 0;
  };
  return bytes;
};
