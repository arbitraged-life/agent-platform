import test from 'node:test';
import assert from 'node:assert/strict';
import { remediate, finalize } from '../../runtime/review-remediation/controller.mjs';
import { seal } from '../../runtime/review-remediation/github.mjs';
import { fingerprint } from '../../runtime/review-remediation/policy.mjs';

function fixture({before=1,after=0,agentCode=0}={}) {
  const policy={repository:'owner/repo',reviewers:[{id:11,login:'review[bot]'}],maxAttempts:2,maxThreads:8,maxFiles:8,maxBytes:10000,
    allowedPrefixes:['src/'],deniedPrefixes:[],requiredChecks:['Verify'],checkAppId:15368,verifiers:[{id:'regression',path:'^src/',body:'bug'}]};
  const pr={number:7,state:'open',draft:false,head:{sha:'a'.repeat(40),ref:'feature',repo:{full_name:'owner/repo'}},base:{ref:'main'}};
  const thread={id:'T1',path:'src/a.js',isResolved:false,isOutdated:false,comments:[{id:123,user:{id:11,login:'review[bot]',type:'Bot'},body:'Fix bug',updated_at:'now'}]};
  let records=[],published=0,agentCalls=0,checks=[];
  const api={token:'test-key',rest:async(path,method='GET',body)=>{
    if(path==='/user')return{id:99};
    if(method==='POST'&&path.endsWith('/comments')){const c={id:records.length+1,user:{id:99},body:body.body};records.push(c);return c;}
    if(method==='PATCH'){records.find(c=>c.id===Number(path.split('/').at(-1))).body=body.body;return{};}
    if(method==='POST'&&path.endsWith('/replies'))return{id:444};
    if(path.endsWith('/pulls/7'))return structuredClone(pr);
    throw new Error(`Unexpected API call ${method} ${path}`);
  },all:async()=>structuredClone(records),threads:async()=>structuredClone([thread]),checks:async()=>checks,
    publish:async(repo,branch,sha)=>{assert.equal(sha,pr.head.sha);published++;pr.head.sha='b'.repeat(40);return{oid:pr.head.sha};},
    resolve:async()=>{thread.isResolved=true;}};
  let passes=0;
  const executor={prepare:async()=>({}),verify:async()=>({syntax:0,regression:passes++?after:before}),
    run:async()=>{agentCalls++;return{code:agentCode};},changes:async()=>[{path:'src/a.js',type:'file',content:'fixed'}],cleanup:async()=>{}};
  return{policy,api,executor,pr,thread,counts:()=>({published,agentCalls}),green:()=>{checks=[{name:'Verify',status:'completed',conclusion:'success',appId:15368}];}};
}

test('dry run reads eligibility without invoking agent or writing state',async()=>{
  const f=fixture();const result=await remediate({...f,number:7,apply:false});
  assert.equal(result.status,'eligible');assert.deepEqual(f.counts(),{published:0,agentCalls:0});
});
test('verified patch is published but thread waits for CI at the exact new SHA',async()=>{
  const f=fixture();const result=await remediate({...f,number:7,apply:true});
  assert.equal(result.status,'pending-ci');assert.deepEqual(f.counts(),{published:1,agentCalls:1});assert.equal(f.thread.isResolved,false);
  f.green();await finalize({...f,number:7});assert.equal(f.thread.isResolved,true);
});
test('unavailable verifier never invokes agent or resolves',async()=>{
  const f=fixture({before:2});const result=await remediate({...f,number:7,apply:true});
  assert.equal(result.status,'unverified');assert.deepEqual(f.counts(),{published:0,agentCalls:0});assert.equal(f.thread.isResolved,false);
});
test('failed agent attempt is recorded and identical delivery is deduplicated',async()=>{
  const f=fixture({agentCode:124});await remediate({...f,number:7,apply:true});
  const again=await remediate({...f,number:7,apply:true});
  assert.equal(again.status,'duplicate');assert.deepEqual(f.counts(),{published:0,agentCalls:1});
});
test('failed post-fix verifier prevents publication and resolution',async()=>{
  const f=fixture({after:1});const result=await remediate({...f,number:7,apply:true});
  assert.equal(result.status,'unverified');assert.equal(f.counts().published,0);assert.equal(f.thread.isResolved,false);
});

test('a head update during agent work prevents a stale publish',async()=>{
  const f=fixture();const original=f.executor.run;
  f.executor.run=async()=>{const result=await original();f.pr.head.sha='c'.repeat(40);return result;};
  const result=await remediate({...f,number:7,apply:true});
  assert.equal(result.status,'failed');assert.equal(f.counts().published,0);
});
test('attempt cap survives changes to the PR head',async()=>{
  const f=fixture({agentCode:124});f.executor.verify=async()=>({syntax:0,regression:1});
  await remediate({...f,number:7,apply:true});f.pr.head.sha='c'.repeat(40);
  await remediate({...f,number:7,apply:true});f.pr.head.sha='d'.repeat(40);
  const result=await remediate({...f,number:7,apply:true});
  assert.equal(result.status,'budget-exhausted');assert.equal(f.counts().agentCalls,2);
});
test('a patch containing the controller credential is never published',async()=>{
  const f=fixture();f.executor.changes=async()=>[{path:'src/a.js',type:'file',content:'test-key'}];
  const result=await remediate({...f,number:7,apply:true});
  assert.equal(result.status,'failed');assert.equal(f.counts().published,0);
});
test('invalid ledger signature cannot consume an attempt or suppress remediation',async()=>{
  const f=fixture();
  const forged={version:1,type:'attempt',repository:f.policy.repository,pr:7,
    key:fingerprint(f.pr,[f.thread]),status:'reserved',attempt:1};
  await f.api.rest('/repos/owner/repo/issues/7/comments','POST',{body:seal(forged,'wrong-key')});
  const result=await remediate({...f,number:7,apply:false});
  assert.equal(result.status,'eligible');
  assert.deepEqual(f.counts(),{published:0,agentCalls:0});
});
test('rotated signing credentials do not validate old proof records',async()=>{
  const f=fixture();await remediate({...f,number:7,apply:true});f.green();f.api.token='rotated-key';
  await finalize({...f,number:7});assert.equal(f.thread.isResolved,false);
});

test('fixing one finding cannot publish a regression or lost evidence in another passing check',async()=>{
  for(const next of [1,2,undefined]) {
    const f=fixture();let checks=0;
    f.executor.verify=async()=>checks++ ? {syntax:0,regression:0,previouslyPassing:next} :
      {syntax:0,regression:1,previouslyPassing:0};
    const result=await remediate({...f,number:7,apply:true});
    assert.equal(result.status,'unverified');
    assert.equal(f.counts().published,0);
    assert.equal(f.thread.isResolved,false);
  }
});
