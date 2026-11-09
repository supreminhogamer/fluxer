import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publicAddress,listenPort,configure} from '../configure.mjs';
import {patchService} from '../patch.mjs';

test('public HTTPS address only',()=>{
  assert.deepEqual(publicAddress({ALTARE_URL:'chat.go.altare.global'}),{origin:'https://chat.go.altare.global',domain:'chat.go.altare.global'});
  assert.throws(()=>publicAddress({ALTARE_URL:'http://invalid.example'}));
  assert.throws(()=>publicAddress({ALTARE_URL:'https://user:pass@invalid.example'}));
});
test('port must be unprivileged',()=>{
  assert.equal(listenPort({PORT:'25565'}),25565);
  assert.throws(()=>listenPort({PORT:'443'}));
});
test('stable credentials and correct proxy origin',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fluxer-altare-'));
  try {
    const env={ALTARE_URL:'chat.go.altare.global',PORT:'21875',FLUXER_POSTGRES_URL:'postgresql://u:p@db.example.com/fluxer?sslmode=require'};
    const result=await configure(dir,env);
    const first=await readFile(path.join(dir,'secrets.env'),'utf8');
    await configure(dir,env);
    const second=await readFile(path.join(dir,'secrets.env'),'utf8');
    assert.equal(first,second);
    assert.equal(result.port,21875);
    const config=await readFile(path.join(dir,'fluxer.env'),'utf8');
    assert.match(config,/EDGE_SITE_ADDRESS='http:\/\/chat.go.altare.global:21875'/);
    assert.match(config,/FLUXER_API_PRESIGNED_ATTACHMENT_UPLOADS_ENABLED='false'/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('patch fails closed on incompatible Snap entrypoint',()=>assert.throws(()=>patchService('cat /dev/null'),/changed/));
test('patch removes privileged postgres and valkey operations',()=>{
  const source=`#!/bin/bash
. "$SNAP/bin/lib.sh"
name="$1"
load_env
run_svc() {
    [ "\${4:-}" = postgres ] && wait_port "$PORT_POSTGRES" postgres
}
case "$name" in
postgres)
    chown snap_daemon:snap_daemon "$STATE/postgres"
    ;;
valkey)
    as_daemon valkey-server --bind 127.0.0.1
    ;;
nats)
    exec nats-server
    ;;
api)
    wait_port "$PORT_POSTGRES" postgres
    ;;
esac
`;
  const patched=patchService(source);
  assert.match(patched,/wait_db\(\)/);
  assert.equal(patched.includes('chown snap_daemon'),false);
  assert.equal(patched.includes('as_daemon valkey'),false);
  assert.equal(patched.includes('wait_port "$PORT_POSTGRES" postgres'),false);
});
