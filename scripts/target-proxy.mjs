import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { createProxyServer } from 'http-proxy-3';
import ts from 'typescript';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const FORWARDED_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
];
const moduleDirectory = String(import.meta.url).startsWith('file:')
  ? dirname(fileURLToPath(import.meta.url))
  : process.cwd();
const BRIDGE_SOURCE_PATH = resolve(moduleDirectory, '..', 'bridge', 'vera-inspector-bridge.ts');
const COMPATIBILITY_SOURCE_PATH = resolve(moduleDirectory, '..', 'bridge', 'vera-inspector-compatibility.ts');
const HTML2CANVAS_PATH = resolve(moduleDirectory, '..', 'node_modules', 'html2canvas', 'dist', 'html2canvas.min.js');
const BRIDGE_SOURCES = [BRIDGE_SOURCE_PATH, COMPATIBILITY_SOURCE_PATH, HTML2CANVAS_PATH];
const BRIDGE_MARKER = 'data-design-inspector="compatibility"';
const DEFAULT_DOCUMENT_LIMIT = 5 * 1024 * 1024;
const bridgeArtifacts = new Map();

/**
 * A fingerprint of the Bridge sources, from mtime and size.
 *
 * The sources are transpiled once and then served forever, which is right for a
 * production proxy and quietly wrong in development: editing
 * `vera-inspector-bridge.ts` had no effect at all until the proxy was restarted,
 * so a new command simply did not exist and a message that arrived was ignored
 * with nothing in the log to say why. Comparing the stamp on each read turns
 * that into an ordinary reload.
 */
async function fingerprintSources(paths) {
  const parts = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      parts.push(`${info.mtimeMs}:${info.size}`);
    } catch {
      parts.push('missing');
    }
  }
  return parts.join('|');
}

/**
 * Reads the sources once and again whenever one of them changes.
 *
 * Takes its paths so the reload rule can be exercised against a scratch
 * directory instead of the live Bridge.
 */
export function createBridgeSourceLoader(paths) {
  let promise = null;
  let stamp = '';
  return async function load() {
    const current = await fingerprintSources(paths);
    if (promise && stamp === current) return promise;
    const previous = promise;
    const next = Promise.all(paths.map((path) => readFile(path, 'utf8'))).catch((error) => {
      // Leave the previous sources in place so one failed read does not take a
      // working target offline; the stamp is not advanced, so the next call
      // retries.
      if (!previous) throw error;
      return previous;
    });
    promise = next;
    stamp = current;
    // The transpiled artifact is cached per origin, so it has to go with the
    // sources it was built from or the reload would be invisible.
    if (previous) bridgeArtifacts.clear();
    return next;
  };
}

const getBridgeSources = createBridgeSourceLoader(BRIDGE_SOURCES);

function asHeaderValues(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null) return [];
  return [String(value)];
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function isolatedProxyHost() {
  const bytes = randomBytes(3);
  const first = bytes[0] || 1;
  const second = bytes[1] || 1;
  const third = bytes[2] || 1;
  const host = `127.${first}.${second}.${third}`;
  return host === '127.0.0.1' ? '127.0.0.2' : host;
}

function isLoopbackHostname(hostname) {
  const value = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(value)) return true;
  return /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(value);
}

export function normalizeLoopbackTargetUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('Target URL is invalid.');
  }
  if (url.protocol !== 'http:') {
    throw new Error('Only HTTP local targets are supported.');
  }
  if (url.username || url.password) {
    throw new Error('Target URL credentials are not supported.');
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error('Target URL must use localhost or a loopback IP address.');
  }
  const port = validPort(url.port);
  if (!port) {
    throw new Error('Target URL must include a valid port.');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Target URL must be a loopback origin without a path or query.');
  }
  if (url.hostname.toLowerCase() === 'localhost') url.hostname = '127.0.0.1';
  url.path = '/';
  return url.origin;
}

export function normalizeAppOrigin(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('Inspector origin is invalid.');
  }
  if (url.protocol !== 'http:') {
    throw new Error('Inspector origin must use HTTP.');
  }
  if (url.username || url.password || !isLoopbackHostname(url.hostname)) {
    throw new Error('Inspector origin must be a loopback origin.');
  }
  if (!validPort(url.port) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Inspector origin must include a valid port and no path.');
  }
  return url.origin;
}

export function rewriteFramePolicy(value, frameOrigins) {
  const origins = [...new Set(frameOrigins)];
  const directive = `frame-ancestors ${origins.join(' ')}`;
  const policies = asHeaderValues(value);
  if (policies.length === 0) return directive;
  const rewritten = policies.map((policy) => {
    const directives = policy
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part && !/^frame-ancestors\b/i.test(part));
    directives.push(directive);
    return directives.join('; ');
  });
  return rewritten.length === 1 ? rewritten[0] : rewritten;
}

export function rewriteInspectorPolicy(value, frameOrigins, scriptHash = null) {
  const origins = [...new Set(frameOrigins)];
  const frameDirective = `frame-ancestors ${origins.join(' ')}`;
  const policies = asHeaderValues(value);
  if (policies.length === 0) return frameDirective;
  const rewritten = policies.map((policy) => {
    const directives = policy
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !/^frame-ancestors\b/i.test(part))
      .filter((part) => !/^sandbox\b/i.test(part));
    const scriptIndex = directives.findIndex((part) => /^script-src\b/i.test(part));
    const elementIndex = directives.findIndex((part) => /^script-src-elem\b/i.test(part));
    const imageIndex = directives.findIndex((part) => /^img-src\b/i.test(part));
    const defaultIndex = directives.findIndex((part) => /^default-src\b/i.test(part));
    if (scriptHash) {
      if (scriptIndex >= 0) {
        const tokens = directives[scriptIndex]
          .split(/\s+/)
          .slice(1)
          .filter((token) => !/^'none'$/i.test(token) && token !== scriptHash);
        directives[scriptIndex] = `script-src ${[...tokens, scriptHash].join(' ')}`;
      } else if (defaultIndex >= 0) {
        const tokens = directives[defaultIndex]
          .split(/\s+/)
          .slice(1)
          .filter((token) => !/^'none'$/i.test(token));
        directives.push(`script-src ${[...tokens, scriptHash].join(' ')}`);
      }
      if (elementIndex >= 0) {
        const tokens = directives[elementIndex]
          .split(/\s+/)
          .slice(1)
          .filter((token) => !/^'none'$/i.test(token) && token !== scriptHash);
        directives[elementIndex] = `script-src-elem ${[...tokens, scriptHash].join(' ')}`;
      }
      if (imageIndex >= 0) {
        const tokens = directives[imageIndex]
          .split(/\s+/)
          .slice(1)
          .filter((token) => !/^'none'$/i.test(token) && token !== 'data:' && token !== 'blob:');
        if (tokens.length === 0) tokens.push("'self'");
        directives[imageIndex] = `img-src ${[...tokens, 'data:', 'blob:'].join(' ')}`;
      }
    }
    directives.push(frameDirective);
    return directives.join('; ');
  });
  return rewritten.length === 1 ? rewritten[0] : rewritten;
}

export function stripCookieDomain(value) {
  return value.replace(/;\s*domain\s*=\s*[^;]*/gi, '');
}

export async function getInspectorBridgeArtifact(appOrigin) {
  const origin = normalizeAppOrigin(appOrigin);
  const cached = bridgeArtifacts.get(origin);
  if (cached) return cached;
  const [bridgeSource, compatibilitySource, html2canvasSource] = await getBridgeSources();
  const transpile = (source, fileName) => {
    const result = ts.transpileModule(source, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        removeComments: true,
      },
    });
    const errors = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (errors.length > 0) {
      throw new TypeError(`Inspector Bridge transpile failed: ${ts.flattenDiagnosticMessageText(errors[0].messageText, '\n')}`);
    }
    return result.outputText;
  };
  const bridgeOutput = transpile(bridgeSource, 'vera-inspector-bridge.ts');
  const compatibilityOutput = transpile(compatibilitySource, 'vera-inspector-compatibility.ts');
  const options = JSON.stringify({ appOrigin: origin, initialMode: 'html', bridgeKind: 'compatibility' });
  const wrapper = `(function(){"use strict";if(window.parent===window.top){function boot(){var current=window.__DESIGN_INSPECTOR_BRIDGE__;if(current&&current.kind==="native")return;if(current&&typeof current.destroy==="function")current.destroy();if(navigator.serviceWorker&&typeof navigator.serviceWorker.getRegistrations==="function"){navigator.serviceWorker.getRegistrations().then(function(registrations){registrations.forEach(function(registration){void registration.unregister();});},function(){});}var inspectorHtml2canvasDescriptor=Object.getOwnPropertyDescriptor(window,"html2canvas");${html2canvasSource}\nvar bridgeModule={exports:{}};var exports=bridgeModule.exports;${bridgeOutput}\nwindow.VeraInspectorCore=bridgeModule.exports;var compatibilityModule={exports:{}};var exports=compatibilityModule.exports;${compatibilityOutput}\nvar inspectorBridge=compatibilityModule.exports.initCompatibilityBridge(${options});var inspectorDestroy=inspectorBridge.destroy;inspectorBridge.destroy=function(){inspectorDestroy.call(inspectorBridge);if(inspectorHtml2canvasDescriptor){Object.defineProperty(window,"html2canvas",inspectorHtml2canvasDescriptor);}else{delete window.html2canvas;}delete window.VeraInspectorCore;};delete window.VeraInspectorCore;}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",function(){window.setTimeout(boot,0);},{once:true});}else{window.setTimeout(boot,0);}}})();`;
  const scriptText = wrapper.replace(/<\/script/gi, '<\\/script');
  const scriptHash = `'sha256-${createHash('sha256').update(scriptText).digest('base64')}'`;
  const artifact = { scriptText, scriptHash };
  bridgeArtifacts.set(origin, artifact);
  return artifact;
}

function nextMarkupTag(html, start = 0) {
  for (let index = html.indexOf('<', start); index >= 0; index = html.indexOf('<', index + 1)) {
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      index = end < 0 ? html.length : end + 2;
      continue;
    }
    if (html.startsWith('<![CDATA[', index)) {
      const end = html.indexOf(']]>', index + 9);
      index = end < 0 ? html.length : end + 2;
      continue;
    }
    if (html.startsWith('<!', index) || html.startsWith('<?', index)) {
      const end = html.indexOf('>', index + 2);
      index = end < 0 ? html.length : end;
      continue;
    }
    const match = /^<(\/?)([A-Za-z][\w:-]*)/.exec(html.slice(index, index + 96));
    if (match) {
      const closing = match[1] === '/';
      const name = match[2].toLowerCase();
      if (!closing && ['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes'].includes(name)) {
        const closeStart = html.toLowerCase().indexOf(`</${name}`, index + match[0].length);
        if (closeStart >= 0) {
          const closeEnd = html.indexOf('>', closeStart);
          index = closeEnd < 0 ? html.length : closeEnd;
          continue;
        }
      }
      return { index, closing, name };
    }
  }
  return null;
}

function findMarkupTag(html, name, closing = false) {
  let cursor = 0;
  while (cursor < html.length) {
    const tag = nextMarkupTag(html, cursor);
    if (!tag) return null;
    if (tag.name === name && tag.closing === closing) return tag;
    cursor = tag.index + 1;
  }
  return null;
}

function markupTagEnd(html, start) {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function htmlAttribute(tag, name) {
  const expression = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    'i',
  );
  const match = expression.exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function escapeHtmlAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function rewriteMetaPolicies(html, frameOrigins, scriptHash) {
  let output = '';
  let cursor = 0;
  while (cursor < html.length) {
    const tag = nextMarkupTag(html, cursor);
    if (!tag) {
      output += html.slice(cursor);
      break;
    }
    const end = markupTagEnd(html, tag.index);
    if (end < 0) {
      output += html.slice(cursor);
      break;
    }
    output += html.slice(cursor, tag.index);
    const source = html.slice(tag.index, end + 1);
    if (tag.name === 'meta' && /content-security-policy/i.test(htmlAttribute(source, 'http-equiv') ?? '')) {
      const content = htmlAttribute(source, 'content');
      if (content !== null) {
        const policy = rewriteInspectorPolicy(content, frameOrigins, scriptHash);
        const encoded = escapeHtmlAttribute(String(policy));
        output += source.replace(
          /(\bcontent\s*=\s*)(?:"[^"]*"|'[^']*')/i,
          (_match, prefix) => `${prefix}"${encoded}"`,
        );
      } else {
        output += source;
      }
    } else {
      output += source;
    }
    cursor = end + 1;
  }
  return output;
}

export function injectInspectorBridge(html, scriptText, scriptHash, frameOrigins) {
  if (/<script\b[^>]*\bdata-design-inspector\s*=\s*["']compatibility["']/i.test(html)) {
    return html;
  }
  const tag = `<script ${BRIDGE_MARKER}>${scriptText}</script>`;
  const closingHead = findMarkupTag(html, 'head', true);
  if (closingHead) return rewriteMetaPolicies(`${html.slice(0, closingHead.index)}${tag}${html.slice(closingHead.index)}`, frameOrigins, scriptHash);
  const bodyStart = findMarkupTag(html, 'body', false);
  if (bodyStart) return rewriteMetaPolicies(`${html.slice(0, bodyStart.index)}${tag}${html.slice(bodyStart.index)}`, frameOrigins, scriptHash);
  const headStart = findMarkupTag(html, 'head', false);
  const htmlStart = findMarkupTag(html, 'html', false);
  const insertionTag = headStart ?? htmlStart;
  if (insertionTag) {
    const end = markupTagEnd(html, insertionTag.index);
    if (end >= 0) {
      return rewriteMetaPolicies(`${html.slice(0, end + 1)}${tag}${html.slice(end + 1)}`, frameOrigins, scriptHash);
    }
  }
  const doctype = /<!doctype\b/i.exec(html);
  if (doctype) {
    const end = markupTagEnd(html, doctype.index);
    if (end >= 0) return rewriteMetaPolicies(`${html.slice(0, end + 1)}${tag}${html.slice(end + 1)}`, frameOrigins, scriptHash);
  }
  return rewriteMetaPolicies(`${tag}${html}`, frameOrigins, scriptHash);
}

function distinctHeader(proxyRes, name) {
  const distinct = proxyRes.headersDistinct?.[name];
  if (Array.isArray(distinct)) return distinct;
  const value = proxyRes.headers[name];
  return value === undefined ? [] : asHeaderValues(value);
}

function removeForwardingHeaders(headers) {
  for (const name of FORWARDED_HEADERS) delete headers[name];
}

function prepareOutgoingRequest(proxyReq, targetOrigin) {
  const origin = proxyReq.getHeader('origin');
  if (origin) proxyReq.setHeader('origin', targetOrigin);
  const referer = proxyReq.getHeader('referer');
  if (typeof referer === 'string') {
    try {
      const url = new URL(referer);
      url.protocol = new URL(targetOrigin).protocol;
      url.host = new URL(targetOrigin).host;
      proxyReq.setHeader('referer', url.href);
    } catch {
    }
  }
  proxyReq.setHeader('sec-fetch-site', 'same-origin');
}

function rejectAbsoluteRequestTarget(requestUrl) {
  return typeof requestUrl !== 'string' || /^(?:https?:\/\/|\/\/)/i.test(requestUrl);
}

function requestAllowed(req, publicOrigin, configuredAppOrigin) {
  if (!publicOrigin) return false;
  const allowedOrigins = new Set([publicOrigin, configuredAppOrigin]);
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
  const referer = typeof req.headers.referer === 'string' ? req.headers.referer : null;
  const fetchSite = typeof req.headers['sec-fetch-site'] === 'string'
    ? req.headers['sec-fetch-site']
    : null;
  const originAllowed = origin ? allowedOrigins.has(origin) : false;
  let refererAllowed = false;
  if (origin && !originAllowed) return false;
  if (referer) {
    try {
      refererAllowed = allowedOrigins.has(new URL(referer).origin);
    } catch {
      return false;
    }
    if (!refererAllowed) return false;
  }
  if (fetchSite === 'cross-site' && !originAllowed && !refererAllowed) return false;
  if (fetchSite === 'same-site' && !origin && !referer) return false;
  return true;
}

function isDocumentCandidate(req) {
  if (req.method !== 'GET' || req.headers.range) return false;
  const destination = typeof req.headers['sec-fetch-dest'] === 'string'
    ? req.headers['sec-fetch-dest'].toLowerCase()
    : '';
  if (destination && !['document', 'iframe', 'frame', 'empty'].includes(destination)) return false;
  const accept = typeof req.headers.accept === 'string' ? req.headers.accept.toLowerCase() : '';
  return !accept || accept.includes('text/html') || accept.includes('application/xhtml+xml') || accept.includes('*/*');
}

function responseMediaType(proxyRes) {
  const value = typeof proxyRes.headers['content-type'] === 'string'
    ? proxyRes.headers['content-type']
    : '';
  return value.split(';', 1)[0].trim().toLowerCase();
}

function supportedDocumentEncoding(proxyRes) {
  const value = typeof proxyRes.headers['content-encoding'] === 'string'
    ? proxyRes.headers['content-encoding'].trim().toLowerCase()
    : '';
  return value === '' || value === 'identity' || value === 'gzip' || value === 'deflate' || value === 'br';
}

function decodeDocument(buffer, encoding, maxOutputLength) {
  if (encoding === '' || encoding === 'identity') return buffer;
  const options = { maxOutputLength };
  if (encoding === 'gzip') return gunzipSync(buffer, options);
  if (encoding === 'deflate') return inflateSync(buffer, options);
  if (encoding === 'br') return brotliDecompressSync(buffer, options);
  throw new Error('unsupported document encoding');
}

function pipeProxyResponse(proxyRes, res, prefix = []) {
  if (res.writableEnded || res.destroyed) return;
  const headers = { ...proxyRes.headers };
  delete headers['transfer-encoding'];
  res.statusCode = proxyRes.statusCode ?? 502;
  if (proxyRes.statusMessage) res.statusMessage = proxyRes.statusMessage;
  res.writeHead(res.statusCode, headers);
  for (const chunk of prefix) res.write(chunk);
  proxyRes.pipe(res);
}

function transformDocumentResponse(proxyRes, res, artifact, frameOrigins, maxDocumentBytes) {
  const rawChunks = [];
  let rawLength = 0;
  let forwarded = false;
  const encoding = typeof proxyRes.headers['content-encoding'] === 'string'
    ? proxyRes.headers['content-encoding'].trim().toLowerCase()
    : '';
  const passThrough = (prefix = rawChunks) => {
    if (forwarded || res.writableEnded || res.destroyed) return;
    forwarded = true;
    pipeProxyResponse(proxyRes, res, prefix);
    rawChunks.length = 0;
  };
  proxyRes.on('data', (chunk) => {
    if (forwarded) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    rawLength += buffer.length;
    if (rawLength > maxDocumentBytes) {
      passThrough([...rawChunks, buffer]);
      return;
    }
    rawChunks.push(buffer);
  });
  proxyRes.once('error', (error) => {
    if (!forwarded) {
      res.destroy(error);
    } else if (!res.destroyed) {
      res.destroy(error);
    }
  });
  proxyRes.once('end', () => {
    if (forwarded) return;
    try {
      const contentType = typeof proxyRes.headers['content-type'] === 'string'
        ? proxyRes.headers['content-type'].toLowerCase()
        : '';
      if (contentType.includes('application/xhtml+xml') || (contentType.includes('charset=') && !contentType.includes('charset=utf-8'))) {
        passThrough();
        return;
      }
      const decoded = decodeDocument(Buffer.concat(rawChunks), encoding, maxDocumentBytes);
      if (decoded.length > maxDocumentBytes) {
        passThrough();
        return;
      }
      const decodedText = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
      const injected = injectInspectorBridge(
        decodedText,
        artifact.scriptText,
        artifact.scriptHash,
        frameOrigins,
      );
      const body = Buffer.from(injected, 'utf8');
      const headers = { ...proxyRes.headers };
      delete headers['content-encoding'];
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      delete headers.etag;
      delete headers['content-md5'];
      delete headers.digest;
      delete headers['content-digest'];
      headers['content-length'] = String(body.length);
      headers['cache-control'] = 'no-store';
      headers['x-inspector-compat-bridge'] = 'injected';
      res.statusCode = proxyRes.statusCode ?? 200;
      if (proxyRes.statusMessage) res.statusMessage = proxyRes.statusMessage;
      res.writeHead(res.statusCode, headers);
      res.end(body);
    } catch {
      passThrough();
    }
  });
}

function writeProxyError(error, response) {
  if (!response || response.writableEnded || response.destroyed) return;
  if ('headersSent' in response && response.headersSent) {
    response.destroy(error);
    return;
  }
  const status = ['ECONNABORTED', 'ECONNECT_TIMEOUT', 'ETIMEDOUT'].includes(error?.code) ? 504 : 502;
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Inspector-Proxy-Error': status === 504 ? 'upstream-timeout' : 'upstream-unavailable',
  });
  response.end(status === 504 ? 'Inspector target timed out.' : 'Inspector target is unavailable.');
}

export async function createTargetProxy({
  targetUrl,
  appOrigin,
  connectTimeout = 10_000,
  compatibilityBridge = true,
  maxDocumentBytes = DEFAULT_DOCUMENT_LIMIT,
  logger = () => {},
}) {
  const upstream = new URL(normalizeLoopbackTargetUrl(targetUrl));
  const proxyHost = isolatedProxyHost();
  const configuredAppOrigin = normalizeAppOrigin(appOrigin);
  const frameOrigins = new Set([configuredAppOrigin]);
  const documentLimit = Number.isSafeInteger(maxDocumentBytes) && maxDocumentBytes > 0
    ? Math.min(maxDocumentBytes, DEFAULT_DOCUMENT_LIMIT)
    : DEFAULT_DOCUMENT_LIMIT;
  const sockets = new Set();
  let publicOrigin = null;
  let closed = false;
  let bridgeArtifact = null;
  let compatibilityError = null;
  if (compatibilityBridge) {
    try {
      bridgeArtifact = await getInspectorBridgeArtifact(configuredAppOrigin);
    } catch (error) {
      compatibilityError = error instanceof Error ? error.message : String(error);
      logger(`compatibility Bridge unavailable: ${compatibilityError}`);
    }
  }

  const proxy = createProxyServer({
    target: upstream,
    changeOrigin: true,
    ws: true,
    xfwd: true,
    followRedirects: false,
    proxyTimeout: 0,
    connectTimeout,
    cookieDomainRewrite: { '*': '' },
  });

  proxy.on('proxyReq', (proxyReq) => {
    prepareOutgoingRequest(proxyReq, upstream.origin);
  });

  proxy.on('proxyReqWs', (proxyReq) => {
    prepareOutgoingRequest(proxyReq, upstream.origin);
  });

  proxy.on('error', (error) => {
    logger(`proxy socket error: ${error?.message ?? error}`);
  });

  proxy.on('proxyRes', (proxyRes, req, res) => {
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['alt-svc'];

    const shouldHandleDocument = Boolean(res) && isDocumentCandidate(req);
    const canInjectBridge = Boolean(
      shouldHandleDocument &&
      bridgeArtifact &&
      proxyRes.statusCode === 200 &&
      ['text/html', 'application/xhtml+xml'].includes(responseMediaType(proxyRes)) &&
      supportedDocumentEncoding(proxyRes),
    );
    const scriptHash = canInjectBridge ? bridgeArtifact.scriptHash : null;

    const enforcedCspValues = distinctHeader(proxyRes, 'content-security-policy');
    proxyRes.headers['content-security-policy'] = enforcedCspValues.length > 0
      ? rewriteInspectorPolicy(enforcedCspValues, frameOrigins, scriptHash)
      : rewriteInspectorPolicy(undefined, frameOrigins, scriptHash);

    const reportOnlyValues = distinctHeader(proxyRes, 'content-security-policy-report-only');
    if (reportOnlyValues.length > 0) {
      proxyRes.headers['content-security-policy-report-only'] = rewriteInspectorPolicy(reportOnlyValues, frameOrigins, scriptHash);
    } else {
      delete proxyRes.headers['content-security-policy-report-only'];
    }

    const cookies = distinctHeader(proxyRes, 'set-cookie');
    if (cookies.length > 0) proxyRes.headers['set-cookie'] = cookies.map(stripCookieDomain);

    const locations = distinctHeader(proxyRes, 'location');
    if (publicOrigin && locations.length > 0) {
      proxyRes.headers.location = locations.map((location) => {
        try {
          const resolved = new URL(location, upstream);
          if (resolved.origin !== upstream.origin) return location;
          return new URL(`${resolved.pathname}${resolved.search}${resolved.hash}`, publicOrigin).href;
        } catch {
          return location;
        }
      });
    }

    const serviceWorkerScope = proxyRes.headers['service-worker-allowed'];
    if (typeof serviceWorkerScope === 'string') {
      try {
        const resolved = new URL(serviceWorkerScope, upstream);
        if (resolved.origin === upstream.origin) {
          proxyRes.headers['service-worker-allowed'] = new URL(resolved.pathname, publicOrigin ?? upstream.origin).href;
        }
      } catch {
      }
    }

    if (shouldHandleDocument) {
      if (canInjectBridge) {
        transformDocumentResponse(proxyRes, res, bridgeArtifact, frameOrigins, documentLimit);
      } else {
        pipeProxyResponse(proxyRes, res);
      }
    }
  });

  const server = createServer((req, res) => {
    if (!requestAllowed(req, publicOrigin, configuredAppOrigin)) {
      res.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Inspector-Proxy-Error': 'forbidden-request',
      });
      res.end('Inspector proxy request origin is not allowed.');
      return;
    }
    if (req.method === 'CONNECT' || rejectAbsoluteRequestTarget(req.url)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid proxy request target.');
      return;
    }
    removeForwardingHeaders(req.headers);
    const documentCandidate = isDocumentCandidate(req);
    if (documentCandidate) {
      delete req.headers['if-none-match'];
      delete req.headers['if-modified-since'];
    }
    proxy.web(req, res, { target: upstream, selfHandleResponse: documentCandidate }, (error) => {
      logger(`proxy http error: ${error?.message ?? error}`);
      writeProxyError(error, res);
    });
  });

  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    if (!requestAllowed(req, publicOrigin, configuredAppOrigin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (req.method === 'CONNECT' || rejectAbsoluteRequestTarget(req.url)) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    removeForwardingHeaders(req.headers);
    socket.on('error', (error) => logger(`proxy websocket error: ${error.message}`));
    proxy.ws(req, socket, head, { target: upstream }, (error) => {
      logger(`proxy websocket upgrade error: ${error?.message ?? error}`);
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, proxyHost);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('Inspector proxy did not receive a TCP port.');
  }

  publicOrigin = `http://${proxyHost}:${address.port}`;

  return {
    targetUrl: upstream.origin,
    appOrigin: configuredAppOrigin,
    proxyUrl: publicOrigin,
    port: address.port,
    compatibilityBridge: Boolean(bridgeArtifact),
    compatibilityError,
    addFrameOrigin(value) {
      frameOrigins.add(normalizeAppOrigin(value));
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
