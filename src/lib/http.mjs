// JSON responses, the shared error shape, and request parsing for HTTP API (payload v2) events.

const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (message, code = 'validation_error') => new HttpError(400, code, message);
export const unauthorized = (message, code = 'unauthorized') => new HttpError(401, code, message);
export const notFound = (message = 'Plan not found.') => new HttpError(404, 'not_found', message);
export const conflict = (code, message) => new HttpError(409, code, message);

export function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json(err.status, { error: { code: err.code, message: err.message, ...err.extra } });
  }
  console.error('Unhandled error', err);
  return json(500, { error: { code: 'internal_error', message: 'Something went wrong on our side. Please retry.' } });
}

/** Wraps a route handler so every failure leaves as the documented error shape. */
export function route(fn) {
  return async (event, context) => {
    try {
      return await fn(event, context);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function header(event, name) {
  const headers = event?.headers ?? {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export const queryParam = (event, name) => event?.queryStringParameters?.[name];
export const pathParam = (event, name) => event?.pathParameters?.[name];

/**
 * Parses a JSON object body. With `optional`, an empty body yields {} (one-tap push
 * buttons POST with no body at all).
 */
export function readJsonBody(event, { optional = false } = {}) {
  let raw = event?.body ?? '';
  if (raw && event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw new HttpError(413, 'body_too_large', `Request body must be at most ${MAX_BODY_BYTES} bytes.`);
  }
  if (raw.trim() === '') {
    if (optional) return {};
    throw badRequest('Request body must be a JSON object.', 'invalid_json');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('Request body is not valid JSON.', 'invalid_json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Request body must be a JSON object.', 'invalid_json');
  }
  return parsed;
}

/** Caller IP as seen by API Gateway (not a client-supplied header, so it cannot be spoofed). */
export const sourceIp = (event) => event?.requestContext?.http?.sourceIp ?? 'unknown';

/** Public base URL of this API, taken from the request (avoids a template circular dependency). */
export function apiBaseFrom(event) {
  const override = process.env.API_BASE_URL;
  if (override) return override.replace(/\/+$/, '');
  const domain = event?.requestContext?.domainName ?? header(event, 'host');
  return `https://${domain}`;
}
