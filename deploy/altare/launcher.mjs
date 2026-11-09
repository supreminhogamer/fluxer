// SPDX-License-Identifier: AGPL-3.0-or-later
// A single foreground process which supervises the official, precompiled Fluxer snap services.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { configure } from './configure.mjs';
import { writePatchedService } from './patch.mjs';

const RELEASE = 'altare-bundle-snap-r7';
const NAME = 'fluxer-server-amd64-r7.tar.gz';
const URL = `https://github.com/supreminhogamer/fluxer/releases/download/${RELEASE}/${NAME}`;
const services = ['postgres','valkey','nats','meilisearch','seaweedfs','livekit',
  'snowflakes','users','gifs','messages','unfurl','api','worker','gateway',
  'media-proxy','push','app-proxy','admin','edge'];
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function exists(p) {try {await access(p);return true;}catch{return false;}}
function task(command,args,opts={}) {
  return new Promise((resolve,reject)=>{
    const child = spawn(command,args,{stdio:'inherit',...opts});
    child.once('error',reject);
    child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${command} exited: ${code ?? signal}`)));
  });
}
async function download(source,dest) {
  const response = await fetch(source,{headers:{'User-Agent':'fluxer-altare-launcher'}});
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} for ${source}`);
  await pipeline(Readable.fromWeb(response.body),createWriteStream(dest,{flags:'wx',mode:0o600}));
}
async function downloadBundle(runtime) {
  const snap = path.join(runtime,'bundle');
  if (await exists(path.join(snap,'bin','service'))) return snap;
  const archive = path.join(runtime,`bundle.${process.pid}.tar.gz`);
  const work = path.join(runtime,`bundle.${process.pid}.partial`);
  const source = process.env.FLUXER_ALTARE_BUNDLE_URL || URL;
  const hashUri = process.env.FLUXER_ALTARE_BUNDLE_SHA256_URL || source+'.sha256';
  console.log('[Fluxer] Downloading the verified official precompiled runtime bundle');
  try {
    const shaResponse = await fetch(hashUri);
    if (!shaResponse.ok) throw new Error('Missing published checksum for runtime bundle');
    const shaText = await shaResponse.text();
    const expected = shaText.trim().split(/\s+/)[0];
    if (!/^[0-9a-fA-F]{64}$/.test(expected)) throw new Error('Invalid SHA-256 checksum');
    await download(source, archive);
    const hash = createHash('sha256');
    const {createReadStream}=await import('node:fs');
    for await (const block of createReadStream(archive)) hash.update(block);
    if (hash.digest('hex').toLowerCase()!==expected.toLowerCase()) throw new Error('Runtime bundle checksum mismatch');
    await mkdir(work,{recursive:true});
    await task('tar',['-xzf',archive,'-C',work,'--no-same-owner','--no-same-permissions']);
    for (const required of ['bin/service','bin/lib.sh','etc/Caddyfile','meta/snap.yaml']) {
      if (!await exists(path.join(work,required))) throw new Error(`Runtime missing ${required}`);
    }
    await rename(work,snap);
  } finally {
    await rm(archive,{force:true}).catch(()=>{});
    await rm(work,{recursive:true,force:true}).catch(()=>{});
  }
  return snap;
}
function runtimeEnvironment(snap,state) {
  return {
    ...process.env,
    SNAP:snap, SNAP_COMMON:state,
    SNAP_VERSION: '2026.1104.180331',
    SNAP_LAUNCHER_ARCH_TRIPLET:'x86_64-linux-gnu',
    PATH:[path.join(snap,'opt/node/bin'),path.join(snap,'usr/bin'),path.join(snap,'bin'),path.join(snap,'usr/sbin'),path.join(snap,'sbin'),process.env.PATH||''].join(':'),
    LD_LIBRARY_PATH:[path.join(snap,'opt/native/lib'),path.join(snap,'usr/lib/x86_64-linux-gnu'),path.join(snap,'lib/x86_64-linux-gnu'),path.join(snap,'usr/lib/postgresql/18/lib'),process.env.LD_LIBRARY_PATH||''].join(':'),
    SSL_CERT_FILE:path.join(snap,'etc/ssl/certs/ca-certificates.crt'),
    NODE_EXTRA_CA_CERTS:path.join(snap,'etc/ssl/certs/ca-certificates.crt'),
  };
}
async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Altare native bundle supports Linux x86-64 only');
  const home=os.homedir();
  const state=path.resolve(process.env.FLUXER_ALTARE_DATA_DIR||path.join(home,'fluxer-data'));
  const runtime=path.resolve(process.env.FLUXER_ALTARE_RUNTIME_DIR||path.join(home,'.fluxer-altare'));
  await mkdir(runtime,{recursive:true,mode:0o700});
  await mkdir(state,{recursive:true,mode:0o700});
  const external = process.env.FLUXER_POSTGRES_URL || process.env.DATABASE_URL;
  const {origin,port} = await configure(state);
  if (!external && process.getuid?.()===0) throw new Error('Postgres requires a non-root account');
  if (!external) console.log('[Fluxer] Bundled PostgreSQL enabled (unprivileged mode)');
  console.log(`[Fluxer] Public address: ${origin}; Altare HTTP port: ${port}`);
  console.log('[Fluxer] Ensure persisted data survives redeploys; external TURN/UDP needed for reliable voice/video');
  const snap=process.env.FLUXER_ALTARE_EXISTING_SNAP || await downloadBundle(runtime);
  if (!await exists(path.join(snap,'bin/service'))) throw new Error('The bundle is missing bin/service');
  const patched=path.join(runtime,'service-altare');
  await writePatchedService(path.join(snap,'bin/service'),patched);
  const env=runtimeEnvironment(snap,state);
  // Do not allow stale database readiness marker to survive a restart.
  await rm(path.join(state,'run','postgres.ready'),{force:true});
  const active=new Map();
  let stopping=false;
  const stop=()=>{
    if (stopping) return;
    stopping=true;
    for (const child of active.values()) child.kill('SIGTERM');
    setTimeout(()=>{for(const child of active.values()) child.kill('SIGKILL');},15000).unref();
  };
  process.on('SIGTERM',stop);
  process.on('SIGINT',stop);
  const launched=[];
  for (const name of services) {
    if (name==='postgres' && external) continue;
    const child=spawn('bash',[patched,name],{env,stdio:'inherit'});
    active.set(name,child);
    child.once('error',e=>{console.error(`[Fluxer/${name}] spawn error: ${e.message}`);stop();});
    child.once('exit',(code,signal)=>{
      active.delete(name);
      if (!stopping) {console.error(`[Fluxer/${name}] exited (${code??signal}); stopping to avoid partial service`);stop();}
    });
    launched.push(name);
    await delay(250);
  }
  console.log(`[Fluxer] Started ${launched.length} service launchers; watch readiness and logs in Altare console`);
  while (!stopping) await delay(1000);
  while(active.size) await delay(200);
  process.exitCode=1;
}
main().catch(error=>{console.error(`[Fluxer/Altare] ${error.message}`);process.exitCode=1;});
