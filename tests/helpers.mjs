// Shared test setup: a fake Lambda environment and small event builders.

process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
process.env.AWS_SESSION_TOKEN = 'session-token-example';
process.env.TABLE_NAME = 'lastcall-test';
process.env.STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:lastcall';
process.env.WEB_BASE_URL = 'https://d123.cloudfront.net';
process.env.DAILY_PLAN_CAP = '20';

// Handlers log expected conditions (closed tasks, failed webhooks). Keep test output
// readable; set LASTCALL_TEST_LOGS=1 to see them.
if (!process.env.LASTCALL_TEST_LOGS) {
  for (const level of ['info', 'warn', 'error']) console[level] = () => {};
}

export const API_DOMAIN = 'abc123.execute-api.us-east-1.amazonaws.com';
export const API = `https://${API_DOMAIN}`;
export const WEB = 'https://d123.cloudfront.net';

export function apiEvent({ method = 'GET', path = '/', headers = {}, body, query, params, ip = '203.0.113.7' } = {}) {
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    headers: { 'content-type': 'application/json', ...headers },
    queryStringParameters: query,
    pathParameters: params,
    requestContext: { domainName: API_DOMAIN, http: { method, path, sourceIp: ip } },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

export const parse = (response) => ({ ...response, json: JSON.parse(response.body) });

export const awsError = (name) => Object.assign(new Error(name), { name });
