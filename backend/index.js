'use strict';

const crypto = require('crypto');
const {
  Driver,
  TypedData,
  TypedValues,
  Types,
  getCredentialsFromEnv,
  MetadataAuthService,
} = require('ydb-sdk');

const REQUIRED_ENV = [
  'BOT_TOKEN',
  'OWNER_CHAT_ID',
  'ALLOWED_ORIGIN',
  'YDB_ENDPOINT',
  'YDB_DATABASE',
  'YDB_TABLE',
];

const RATE_LIMIT_SECONDS = Number(process.env.LEAD_RATE_LIMIT_SECONDS || 300);
const AUTH_TTL_SECONDS = Number(process.env.AUTH_TTL_SECONDS || 3600);
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

let driverPromise;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function resolveDriver() {
  if (driverPromise) {
    return driverPromise;
  }

  const endpoint = requiredEnv('YDB_ENDPOINT');
  const database = requiredEnv('YDB_DATABASE');

  const authService =
    process.env.YDB_METADATA_CREDENTIALS === '1'
      ? new MetadataAuthService()
      : getCredentialsFromEnv();

  const connectionString = `grpcs://${endpoint}?database=${database}`;
  const driver = new Driver({
    connectionString,
    authService,
  });

  driverPromise = driver.ready(10_000).then((isReady) => {
    if (!isReady) {
      throw new Error('YDB driver is not ready');
    }
    return driver;
  });

  return driverPromise;
}

function nowIso() {
  return new Date().toISOString();
}

function logEvent(eventType, userId) {
  const payload = {
    event_type: eventType,
    user_id: userId || null,
    timestamp: nowIso(),
  };
  console.log(JSON.stringify(payload));
}

function parseBody(event) {
  if (!event || !event.body) {
    return {};
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  try {
    return JSON.parse(raw);
  } catch (_err) {
    return {};
  }
}

function normalizeOrigin(urlValue) {
  if (!urlValue) {
    return '';
  }
  try {
    const parsed = new URL(urlValue);
    return parsed.origin;
  } catch (_err) {
    return urlValue;
  }
}

function response(statusCode, payload, origin) {
  const allowedOrigin = normalizeOrigin(requiredEnv('ALLOWED_ORIGIN'));
  const isAllowedOrigin = origin === allowedOrigin;

  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': isAllowedOrigin ? origin : allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    },
    body: JSON.stringify(payload),
  };
}

function errorResponse(statusCode, errorCode, message, origin) {
  return response(
    statusCode,
    {
      ok: false,
      error_code: errorCode,
      message,
    },
    origin
  );
}

function verifyInitData(initDataRaw) {
  const botToken = requiredEnv('BOT_TOKEN');
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  const authDateRaw = params.get('auth_date');

  if (!hash || !authDateRaw) {
    return { ok: false, code: 'INVALID_INITDATA', message: 'Invalid Telegram initData' };
  }

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') {
      continue;
    }
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const hashBuffer = Buffer.from(hash, 'hex');
  const checkBuffer = Buffer.from(check, 'hex');
  const safeCompare =
    hashBuffer.length === checkBuffer.length &&
    crypto.timingSafeEqual(hashBuffer, checkBuffer);

  if (!safeCompare) {
    return { ok: false, code: 'INVALID_INITDATA', message: 'Invalid Telegram initData signature' };
  }

  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, code: 'INVALID_INITDATA', message: 'Invalid auth_date value' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - authDate > AUTH_TTL_SECONDS) {
    return { ok: false, code: 'EXPIRED_INITDATA', message: 'Telegram initData expired' };
  }

  let user = null;
  const userRaw = params.get('user');
  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch (_err) {
      return { ok: false, code: 'INVALID_INITDATA', message: 'Invalid user payload' };
    }
  }

  if (!user || typeof user.id !== 'number') {
    return { ok: false, code: 'INVALID_INITDATA', message: 'User data not found in initData' };
  }

  return {
    ok: true,
    user: {
      id: user.id,
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      username: user.username || '',
      photo_url: user.photo_url || '',
    },
  };
}

function asOptionalUtf8(value) {
  if (!value) {
    return TypedValues.optionalNull(Types.UTF8);
  }
  return TypedValues.optional(TypedValues.utf8(value));
}

async function upsertUser(user) {
  const driver = await resolveDriver();
  const tableName = requiredEnv('YDB_TABLE');
  const path = `${requiredEnv('YDB_DATABASE')}/${tableName}`;
  const now = new Date();

  const selectFirstSeenQuery = `
    DECLARE $user_id AS Uint64;
    SELECT first_seen_at FROM \`${path}\` WHERE user_id = $user_id;
  `;

  const firstSeenAt = await driver.tableClient.withSession(async (session) => {
    const result = await session.executeQuery(selectFirstSeenQuery, {
      $user_id: TypedValues.uint64(user.id),
    });
    const rows = TypedData.createNativeObjects(result.resultSets[0]);
    const existing = rows[0]?.first_seen_at;
    return existing ? new Date(existing) : now;
  });

  const query = `
    DECLARE $user_id AS Uint64;
    DECLARE $username AS Optional<Utf8>;
    DECLARE $first_name AS Optional<Utf8>;
    DECLARE $last_name AS Optional<Utf8>;
    DECLARE $first_seen_at AS Timestamp;
    DECLARE $last_seen_at AS Timestamp;

    UPSERT INTO \`${path}\` (
      user_id,
      username,
      first_name,
      last_name,
      first_seen_at,
      last_seen_at
    )
    VALUES (
      $user_id,
      $username,
      $first_name,
      $last_name,
      $first_seen_at,
      $last_seen_at
    );
  `;

  await driver.tableClient.withSession(async (session) => {
    await session.executeQuery(query, {
      $user_id: TypedValues.uint64(user.id),
      $username: asOptionalUtf8(user.username),
      $first_name: asOptionalUtf8(user.first_name),
      $last_name: asOptionalUtf8(user.last_name),
      $first_seen_at: TypedValues.timestamp(firstSeenAt),
      $last_seen_at: TypedValues.timestamp(now),
    });
  });
}

async function getUniqueUsers() {
  const driver = await resolveDriver();
  const tableName = requiredEnv('YDB_TABLE');
  const path = `${requiredEnv('YDB_DATABASE')}/${tableName}`;
  const query = `SELECT COUNT(*) AS total FROM \`${path}\`;`;

  return driver.tableClient.withSession(async (session) => {
    const result = await session.executeQuery(query);
    const rows = TypedData.createNativeObjects(result.resultSets[0]);
    return Number(rows[0]?.total || 0);
  });
}

async function getLastLeadAt(userId) {
  const driver = await resolveDriver();
  const tableName = requiredEnv('YDB_TABLE');
  const path = `${requiredEnv('YDB_DATABASE')}/${tableName}`;
  const query = `
    DECLARE $user_id AS Uint64;
    SELECT last_lead_at FROM \`${path}\` WHERE user_id = $user_id;
  `;

  return driver.tableClient.withSession(async (session) => {
    const result = await session.executeQuery(query, {
      $user_id: TypedValues.uint64(userId),
    });
    const rows = TypedData.createNativeObjects(result.resultSets[0]);
    const value = rows[0]?.last_lead_at;
    if (!value) {
      return null;
    }
    return new Date(value);
  });
}

async function updateLastLeadAt(userId) {
  const driver = await resolveDriver();
  const tableName = requiredEnv('YDB_TABLE');
  const path = `${requiredEnv('YDB_DATABASE')}/${tableName}`;
  const now = new Date();

  const query = `
    DECLARE $user_id AS Uint64;
    DECLARE $lead_at AS Timestamp;
    UPDATE \`${path}\`
    SET last_lead_at = $lead_at
    WHERE user_id = $user_id;
  `;

  await driver.tableClient.withSession(async (session) => {
    await session.executeQuery(query, {
      $user_id: TypedValues.uint64(userId),
      $lead_at: TypedValues.timestamp(now),
    });
  });
}

async function sendLeadMessage(user) {
  const botToken = requiredEnv('BOT_TOKEN');
  const ownerChatId = requiredEnv('OWNER_CHAT_ID');
  const endpoint = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;

  const text = [
    'New mini-app lead',
    `username: ${user.username || '(нет)'}`,
    `user_id: ${user.id}`,
    `first_name: ${user.first_name || '(нет)'}`,
    `last_name: ${user.last_name || '(нет)'}`,
  ].join('\n');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: ownerChatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Telegram API sendMessage failed: ${res.status}`);
  }
}

function getRoute(event) {
  const path = event.path || event.rawPath || '/';
  if (path.endsWith('/validate')) {
    return 'validate';
  }
  if (path.endsWith('/lead')) {
    return 'lead';
  }
  return 'unknown';
}

exports.handler = async function handler(event) {
  for (const envName of REQUIRED_ENV) {
    requiredEnv(envName);
  }

  const method = event?.httpMethod || event?.requestContext?.http?.method || 'GET';
  const headers = event?.headers || {};
  const origin = headers.origin || headers.Origin || '';

  if (method === 'OPTIONS') {
    return response(204, { ok: true }, origin);
  }

  const allowedOrigin = normalizeOrigin(requiredEnv('ALLOWED_ORIGIN'));
  if (origin && origin !== allowedOrigin) {
    return errorResponse(403, 'INTERNAL_ERROR', 'Origin is not allowed', origin);
  }

  if (method !== 'POST') {
    return errorResponse(405, 'INTERNAL_ERROR', 'Method not allowed', origin);
  }

  const route = getRoute(event);
  if (route === 'unknown') {
    return errorResponse(404, 'INTERNAL_ERROR', 'Route not found', origin);
  }

  const body = parseBody(event);
  const initData = typeof body.initData === 'string' ? body.initData : '';

  if (!initData) {
    logEvent(`${route}_fail`, null);
    return errorResponse(400, 'MISSING_INITDATA', 'initData is required', origin);
  }

  const verification = verifyInitData(initData);
  if (!verification.ok) {
    logEvent(`${route}_fail`, null);
    return errorResponse(401, verification.code, verification.message, origin);
  }

  const user = verification.user;

  try {
    await upsertUser(user);

    if (route === 'validate') {
      const uniqueUsers = await getUniqueUsers();
      logEvent('validate_ok', user.id);

      return response(
        200,
        {
          ok: true,
          user: {
            id: user.id,
            first_name: user.first_name || undefined,
            last_name: user.last_name || undefined,
            username: user.username || undefined,
            photo_url: user.photo_url || undefined,
          },
          stats: {
            unique_users: uniqueUsers,
          },
        },
        origin
      );
    }

    const lastLeadAt = await getLastLeadAt(user.id);
    if (lastLeadAt) {
      const deltaSec = Math.floor((Date.now() - lastLeadAt.getTime()) / 1000);
      if (deltaSec < RATE_LIMIT_SECONDS) {
        logEvent('lead_fail', user.id);
        return errorResponse(
          429,
          'RATE_LIMITED',
          `Try again in ${RATE_LIMIT_SECONDS - deltaSec} seconds`,
          origin
        );
      }
    }

    await sendLeadMessage(user);
    await updateLastLeadAt(user.id);
    logEvent('lead_ok', user.id);
    return response(200, { ok: true }, origin);
  } catch (err) {
    logEvent(`${route}_fail`, user.id);
    console.error(`Internal error on route ${route}:`, err && err.message ? err.message : err);
    return errorResponse(500, 'INTERNAL_ERROR', 'Internal server error', origin);
  }
};
