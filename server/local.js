// Ochrana akcí, které mění stav počítače nebo serveru.

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Požadavek z toho samého počítače (ne z mobilu v síti, ne přes cizí doménu = ochrana proti DNS rebindingu). */
export const isLocal = (req) => LOOPBACK.includes(req.ip) && LOCAL_HOST.test(req.headers.host ?? '');

/** Akce měnící stav serveru: jen lokálně a s vlastní hlavičkou (cizí web ji bez CORS nepošle). */
export const isTrusted = (req) => isLocal(req) && req.headers['x-letackomat'] === '1';
