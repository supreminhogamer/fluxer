// SPDX-License-Identifier: AGPL-3.0-or-later
// Generate the same environment shape as the official Fluxer native snap, without snapctl.
import { createECDH, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

const hex = () => randomBytes(32).toString('hex');
const sq = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const safeName = name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
function environmentFile(values) {
  return Object.entries(values).filter(([key]) => safeName(key))
    .map(([key, value]) => `export ${key}=${sq(value)}`).join('\n') + '\n';
}

export function publicAddress(env) {
  const candidate = env.FLUXER_PUBLIC_ORIGIN || env.ALTARE_URL || env.PUBLIC_URL;
  if (!candidate) throw new Error('Missing ALTARE_URL / FLUXER_PUBLIC_ORIGIN; set the HTTPS public URL in Altare');
  const url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Public URL must be an HTTPS origin without path, credentials, query or fragment');
  }
  if (url.port && url.port !== '443') throw new Error('Public HTTPS URL must use port 443 behind Altare proxy');
  return { origin: url.origin, domain: url.hostname };
}
export function listenPort(env) {
  const port = Number(env.PORT || env.SERVER_PORT || env.FLUXER_ALTARE_PORT || 8080);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an unprivileged TCP port (1024–65535)');
  return port;
}
const names = [
  'POSTGRES_PASSWORD', 'MEILI_MASTER_KEY', 'FLUXER_S3_SECRET_KEY', 'FLUXER_SUDO_MODE_SECRET',
  'FLUXER_CONNECTION_INITIATION_SECRET', 'FLUXER_PROFILE_PSEUDONYM_SECRET', 'FLUXER_GATEWAY_RPC_AUTH_TOKEN',
  'FLUXER_ERLANG_COOKIE', 'FLUXER_MEDIA_PROXY_SECRET_KEY', 'FLUXER_ADMIN_SECRET_KEY_BASE',
  'FLUXER_ADMIN_OAUTH_CLIENT_SECRET', 'LIVEKIT_API_SECRET', 'FLUXER_SETUP_TOKEN',
];
export async function readOrCreateSecrets(state) {
  const filename = path.join(state, 'secrets.env');
  let saved = {};
  try {
    const raw = await readFile(filename, 'utf8');
    for (const line of raw.split('\n')) {
      const match = /^([A-Z0-9_]+)=([^\r\n]*)$/.exec(line);
      if (match) saved[match[1]] = match[2];
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of names) saved[name] ||= hex();
  saved.FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64 ||= randomBytes(32).toString('base64');
  if (!saved.FLUXER_ACTIVITYPUB_SIGNING_KEY_BASE64) {
    const {privateKey} = generateKeyPairSync('rsa', {modulusLength:2048});
    saved.FLUXER_ACTIVITYPUB_SIGNING_KEY_BASE64 = privateKey.export({type:'pkcs8',format:'der'}).toString('base64');
  }
  if (!saved.FLUXER_VAPID_PUBLIC_KEY || !saved.FLUXER_VAPID_PRIVATE_KEY) {
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    saved.FLUXER_VAPID_PUBLIC_KEY = ecdh.getPublicKey(null, 'uncompressed').toString('base64url');
    saved.FLUXER_VAPID_PRIVATE_KEY = ecdh.getPrivateKey().toString('base64url');
  }
  saved.LIVEKIT_API_KEY ||= 'fluxer';
  saved.FLUXER_S3_ACCESS_KEY ||= 'fluxer';
  await atomicFile(filename, Object.entries(saved).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
  return saved;
}
async function atomicFile(filename, contents) {
  const temp = `${filename}.${process.pid}.tmp`;
  await writeFile(temp, contents, {mode:0o600});
  await chmod(temp, 0o600);
  await rename(temp, filename);
}
export async function configure(state, env=process.env) {
  await mkdir(state, {recursive:true,mode:0o700});
  await chmod(state, 0o700);
  const secrets = await readOrCreateSecrets(state);
  const {origin,domain} = publicAddress(env);
  const port = listenPort(env);
  const remote = env.FLUXER_POSTGRES_URL || env.DATABASE_URL || '';
  if (remote && !/^postgres(?:ql)?:\/\//.test(remote)) throw new Error('FLUXER_POSTGRES_URL must be a postgres:// or postgresql:// URI');
  // The database is always required; the bundled PostgreSQL can only run as an unprivileged user.
  if (!remote && typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('Cannot start bundled PostgreSQL as root. Run Altare as non-root or configure FLUXER_POSTGRES_URL.');
  }
  const vals = {
    ...secrets,
    FLUXER_ENV:'production', NODE_ENV:'production', FLUXER_SELF_HOSTED:'true',
    FLUXER_BASE_DOMAIN:domain, FLUXER_DOMAIN:domain, FLUXER_PUBLIC_SCHEME:'https', FLUXER_PUBLIC_PORT:'443',
    FLUXER_PUBLIC_ORIGIN:origin, FLUXER_TRUST_CLIENT_IP_HEADER:'true', FLUXER_APP_ENDPOINT:origin,
    FLUXER_MEDIA_ENDPOINT:`${origin}/media`, FLUXER_MEDIA_PROXY_PUBLIC_ENDPOINT:`${origin}/media`,
    FLUXER_ADMIN_ENDPOINT:`${origin}/admin`, FLUXER_MARKETING_ENDPOINT:origin,
    FLUXER_STATIC_CDN_ENDPOINT:origin, FLUXER_ADMIN_BASE_PATH:'/admin',
    FLUXER_DATABASE_BACKEND:'postgres', FLUXER_POSTGRES_HOST:'127.0.0.1', FLUXER_POSTGRES_PORT:'15432',
    FLUXER_POSTGRES_DATABASE:'fluxer', FLUXER_POSTGRES_USERNAME:'fluxer',
    FLUXER_POSTGRES_PASSWORD:secrets.POSTGRES_PASSWORD, FLUXER_POSTGRES_SSL:'false',
    FLUXER_POSTGRES_URL:remote || `postgres://fluxer:${secrets.POSTGRES_PASSWORD}@127.0.0.1:15432/fluxer`,
    FLUXER_KV_URL:'redis://127.0.0.1:16379/0', FLUXER_NATS_URL:'nats://127.0.0.1:14222',
    FLUXER_NATS_JETSTREAM_URL:'nats://127.0.0.1:14222', FLUXER_SVC_NATS_URL:'nats://127.0.0.1:14222',
    FLUXER_SVC_SHARD_COUNT:'1', FLUXER_SEARCH_ENGINE:'meilisearch',
    FLUXER_SEARCH_URL:'http://127.0.0.1:17700', FLUXER_SEARCH_API_KEY:secrets.MEILI_MASTER_KEY,
    FLUXER_S3_ENDPOINT:'http://127.0.0.1:18333', FLUXER_S3_PUBLIC_ENDPOINT:'http://127.0.0.1:18333',
    FLUXER_S3_REGION:'us-east-1', FLUXER_S3_ACCESS_KEY_ID:secrets.FLUXER_S3_ACCESS_KEY,
    FLUXER_S3_SECRET_ACCESS_KEY:secrets.FLUXER_S3_SECRET_KEY, FLUXER_S3_FORCE_PATH_STYLE:'true',
    FLUXER_S3_BUCKET_CDN:'fluxer', FLUXER_S3_BUCKET_UPLOADS:'fluxer-uploads',
    FLUXER_S3_BUCKET_REPORTS:'fluxer-reports', FLUXER_S3_BUCKET_HARVESTS:'fluxer-harvests',
    // Browser cannot reach internal S3; use media-proxy relay rather than presigned uploads.
    FLUXER_API_PRESIGNED_ATTACHMENT_UPLOADS_ENABLED:'false', FLUXER_API_PRESIGNED_HARVEST_DOWNLOADS_ENABLED:'false',
    FLUXER_LIVEKIT_ENABLED:'true', FLUXER_LIVEKIT_BUNDLED:'true',
    FLUXER_LIVEKIT_API_KEY:secrets.LIVEKIT_API_KEY, FLUXER_LIVEKIT_API_SECRET:secrets.LIVEKIT_API_SECRET,
    FLUXER_LIVEKIT_INTERNAL_URL:'http://127.0.0.1:17880', FLUXER_LIVEKIT_URL:`${origin}/livekit`,
    FLUXER_LIVEKIT_DEFAULT_REGION:JSON.stringify({id:'default',name:'Default',emoji:'🌍',latitude:0,longitude:0}),
    FLUXER_LIVEKIT_TURN_SERVERS:env.FLUXER_LIVEKIT_TURN_SERVERS || '[]',
    FLUXER_EMAIL_FROM_EMAIL:`noreply@${domain}`, FLUXER_VAPID_EMAIL:`admin@${domain}`,
    FLUXER_PASSKEY_RP_ID:domain, FLUXER_PASSKEY_ADDITIONAL_ALLOWED_ORIGINS:origin,
    FLUXER_INTERNAL_API_ENDPOINT:'http://127.0.0.1:18080', FLUXER_INTERNAL_MEDIA_PROXY_ENDPOINT:'http://127.0.0.1:18082',
    FLUXER_MEDIA_PROXY_UPLOAD_RELAY_ENDPOINT:`${origin}/media`, AWS_EC2_METADATA_DISABLED:'true',
    LIVEKIT_NODE_IP:env.FLUXER_LIVEKIT_NODE_IP || '', LIVEKIT_TCP_PORT:env.FLUXER_LIVEKIT_TCP_PORT || '7881',
    LIVEKIT_UDP_PORT:env.FLUXER_LIVEKIT_UDP_PORT || '7882',
    EDGE_SITE_ADDRESS:`http://${domain}:${port}`, EDGE_BIND:'bind 0.0.0.0',
    EDGE_GLOBAL_OPTIONS:'admin off\n         auto_https off', EDGE_TLS_DIRECTIVE:'',
  };
  // These are deliberate, documented knobs, not arbitrary environment injection.
  for (const key of [ 'FLUXER_POSTGRES_SSL', 'FLUXER_POSTGRES_PREPARED_STATEMENTS',
    'FLUXER_EMAIL_ENABLED', 'FLUXER_LIVEKIT_ENABLED', 'FLUXER_API_NODE_HEAP_PERCENT',
    'FLUXER_POSTGRES_SHARED_BUFFERS', 'FLUXER_VALKEY_MAXMEMORY', 'FLUXER_MEILISEARCH_MAX_INDEXING_MEMORY',
    'FLUXER_NATS_MAX_FILE_STORE', 'FLUXER_EDGE_TRUSTED_PROXIES' ]) {
    if (env[key] !== undefined) vals[key] = env[key];
  }
  // Credentials must not accidentally enter build logs or Git.
  await atomicFile(path.join(state, 'fluxer.env'), environmentFile(vals));
  return {origin, port, externalPostgres:!!remote};
}
