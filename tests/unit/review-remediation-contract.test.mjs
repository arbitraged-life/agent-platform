import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { DockerExecutor } from '../../runtime/review-remediation/executor.mjs';
import { GitHubClient } from '../../runtime/review-remediation/github.mjs';
import { routeEvent } from '../../runtime/review-remediation/route.mjs';

test('effective agent, proxy, and verifier image requires an immutable digest',()=>{
  const image='ghcr.io/example/agent@sha256:'+ 'a'.repeat(64);
  assert.equal(new DockerExecutor({}, {image}).image,image);
  for(const invalid of [undefined,'agent:latest','ghcr.io/example/agent@sha256:abc']) {
    assert.throws(()=>new DockerExecutor({}, {image:invalid}),/digest/i);
    assert.throws(()=>new DockerExecutor({}, {image},{image:invalid??'agent:latest'}),/digest/i);
  }
});

test('archive streaming cancels before retaining an oversized body',async()=>{
  const api=new GitHubClient('fixture');
  let reads=0,cancelled=false;
  const chunk=new Uint8Array(1024*1024);
  const body=new ReadableStream({pull(controller){reads++;controller.enqueue(chunk);},cancel(){cancelled=true;}});
  api.request=async()=>({url:'https://codeload.github.com/example/archive',body,
    arrayBuffer:async()=>{throw new Error('unbounded read');}});
  await assert.rejects(()=>api.archive('owner/repo','a'.repeat(40)),/archive exceeds size limit/);
  assert.equal(cancelled,true);
  assert.ok(reads<=102);
});

test('archive streaming preserves valid bytes and propagates stream failure',async()=>{
  const api=new GitHubClient('fixture');
  api.request=async()=>({url:'https://codeload.github.com/example/archive',body:new Response('archive').body});
  assert.equal((await api.archive('owner/repo','a'.repeat(40))).toString(),'archive');
  api.request=async()=>({url:'https://codeload.github.com/example/archive',body:new ReadableStream({start(controller){controller.error(new Error('stream failed'));}})});
  await assert.rejects(()=>api.archive('owner/repo','a'.repeat(40)),/stream failed/);
});

test('finalization routes configured workflow names without authorizing unrelated workflows',async()=>{
  const policy={repository:'owner/repo',finalizationWorkflowNames:['Platform Validation']};
  const pr={number:7,state:'open',head:{sha:'a'.repeat(40),ref:'feature',repo:{full_name:'owner/repo'}},base:{ref:'main'}};
  const event={action:'completed',workflow_run:{name:'Platform Validation',head_sha:pr.head.sha}};
  const api={all:async()=>[pr]};
  assert.deepEqual(await routeEvent('workflow_run',event,policy,api),[{pr:7,mode:'finalize'}]);
  assert.deepEqual(await routeEvent('workflow_run',{...event,workflow_run:{...event.workflow_run,name:'CI'}},policy,api),[]);
});


test('malformed signing-key JSON is never echoed by the CLI',async()=>{
 const root=await mkdtemp(join(tmpdir(),'signing-input-'));
 try {
  const config=join(root,'policy.json');
  await writeFile(config,JSON.stringify({allowedPrefixes:['src/'],deniedPrefixes:[],requiredChecks:['Verify'],finalizationWorkflowNames:['CI'],maxAttempts:2,maxThreads:2,maxFiles:2,maxBytes:1024,
   agentTimeoutSeconds:30,maxModelRequests:2,maxOutputTokens:100,checkAppId:1,checkWorkflowId:123,provider:'openrouter',providerEnv:'OPENROUTER_API_KEY',
   model:'openrouter/example',upstreamModel:'example',inferenceEndpoint:'https://provider.example.invalid/chat'}));
  const result=await promisify(execFile)(process.execPath,['scripts/review/remediate.mjs','--config',config,'--mode','route'],{
   env:{...process.env,GH_TOKEN:'fixture',REMEDIATION_SIGNING_KEYS:'sensitive-signing-material-not-json'},
  }).then(()=>{throw new Error('CLI unexpectedly succeeded');},error=>error);
  assert.equal(result.code,1);
  assert.doesNotMatch(result.stdout+result.stderr,/sensitive-signing/);
  assert.match(result.stderr,/Invalid REMEDIATION_SIGNING_KEYS JSON/);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('an archive exactly at the byte ceiling is accepted',async()=>{
 const api=new GitHubClient('fixture');let chunks=0;
 const block=new Uint8Array(1024*1024);
 api.request=async()=>({url:'https://codeload.github.com/example/archive',body:new ReadableStream({
  pull(controller){if(chunks++<100)controller.enqueue(block);else controller.close();},
 })});
 assert.equal((await api.archive('owner/repo','a'.repeat(40))).length,100*1024*1024);
});
