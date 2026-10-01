import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBox, runWithInferenceProxy } from '../../runtime/review-remediation/sandbox.mjs';

async function withDocker(script, check) {
  const root=await mkdtemp(join(tmpdir(),'review-cleanup-'));
  const originalPath=process.env.PATH;
  try {
    await writeFile(join(root,'docker'),`#!${process.execPath}
${script}`,{mode:0o755});
    process.env.PATH=`${root}:${originalPath}`;
    await check(root);
  } finally {
    process.env.PATH=originalPath;
    await rm(root,{recursive:true,force:true});
  }
}

test('a timed out client with unconfirmed container removal rejects',async()=>{
  await withDocker(`
    if(process.argv[2]==='run')setTimeout(()=>{},10000);
    else process.exit(1);
  `,async root=>{
    await assert.rejects(()=>runBox('image',root,['agent'],{timeoutMs:100}),/cleanup/i);
  });
});

test('an already absent container accepts cleanup after a failed remove',async()=>{
  await withDocker(`
    const args=process.argv.slice(2);
    if(args[0]==='rm')process.exit(1);
    process.exit(0);
  `,async root=>{
    assert.equal((await runBox('image',root,['agent'])).code,0);
  });
});

test('proxy removal failure still attempts network cleanup and rejects success',async()=>{
  const log=[];
  await withDocker(`
    const fs=require('node:fs/promises');
    (async()=>{
    const path=require('node:path');
    const args=process.argv.slice(2);
    await fs.appendFile(path.join(__dirname,'commands'),JSON.stringify(args)+String.fromCharCode(10));
    if(args.includes('ls'))process.exit(1);
    if(args[0]==='rm' && args.at(-1).startsWith('review-proxy-'))process.exit(1);
    process.exit(0);
    })();
  `,async root=>{
    await assert.rejects(()=>runWithInferenceProxy('image',root,['agent'],{
      proxyEnvironment:{},controllerDir:root,
    }),/cleanup/i);
    log.push(...(await readFile(join(root,'commands'),'utf8')).trim().split('\n').map(JSON.parse));
    assert.ok(log.some(args=>args[0]==='network' && args[1]==='rm'));
  });
});
