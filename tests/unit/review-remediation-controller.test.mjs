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
  const api={token:'test-key',signingKeys:['ledger-fixture-key'.repeat(2)],rest:async(path,method='GET',body)=>{
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
  assert.equal(result.status,'eligible');assert.deepEqual(f.counts(),{published:0,agentCalls:0});assert.equal((await f.api.all()).length,0);
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
test('unverifiable controller receipts block automatic attempts',async()=>{
  const f=fixture();
  const forged={version:1,type:'attempt',repository:f.policy.repository,pr:7,
    key:fingerprint(f.pr,[f.thread]),status:'reserved',attempt:1};
  await f.api.rest('/repos/owner/repo/issues/7/comments','POST',{body:seal(forged,'wrong-key')});
  await assert.rejects(()=>remediate({...f,number:7,apply:false}),/signing|receipt/i);
  assert.deepEqual(f.counts(),{published:0,agentCalls:0});
});
test('GitHub token rotation preserves valid signed proof records',async()=>{
  const f=fixture();await remediate({...f,number:7,apply:true});f.green();f.api.token='rotated-key';
  await finalize({...f,number:7});assert.equal(f.thread.isResolved,true);
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


test('workspace cleanup runs even when the final GitHub status update fails',async()=>{
  const f=fixture({before:2});
  const rest=f.api.rest;
  let cleaned=false;
  f.api.rest=async(path,method,...args)=>{
    if(method==='PATCH')throw new Error('GitHub unavailable');
    return rest(path,method,...args);
  };
  f.executor.cleanup=async()=>{cleaned=true;};
  await assert.rejects(()=>remediate({...f,number:7,apply:true}),/GitHub unavailable/);
  assert.equal(cleaned,true);
});


test('signing key rotation retains the PR-wide attempt budget',async()=>{
  const f=fixture({agentCode:124});f.executor.verify=async()=>({syntax:0,regression:1});
  await remediate({...f,number:7,apply:true});f.pr.head.sha='c'.repeat(40);
  f.api.token='new-github-token';
  f.api.signingKeys.unshift('new-ledger-fixture-key'.repeat(2));
  await remediate({...f,number:7,apply:true});f.pr.head.sha='d'.repeat(40);
  assert.equal((await remediate({...f,number:7,apply:true})).status,'budget-exhausted');
  assert.equal(f.counts().agentCalls,2);
});

test('missing historical signing key blocks rather than resetting budget',async()=>{
  const f=fixture({agentCode:124});await remediate({...f,number:7,apply:true});
  f.api.signingKeys=['unrelated-ledger-fixture-key'.repeat(2)];
  f.api.token='new-github-token';f.pr.head.sha='d'.repeat(40);
  await assert.rejects(()=>remediate({...f,number:7,apply:true}),/signing|receipt/i);
});


test('corrupt controller receipts cannot silently reset attempt history',async()=>{
 const f=fixture();
 await f.api.rest('/repos/owner/repo/issues/7/comments','POST',{body:'<!-- review-remediation:v1:corrupt -->'});
 await assert.rejects(()=>remediate({...f,number:7,apply:false}),/receipt/i);
 assert.equal(f.counts().agentCalls,0);
});

test('publication stops when selected feedback is resolved, truncated, or expanded',async()=>{
  for(const change of ['resolved','truncated','added']) {
    const f=fixture(),original=f.executor.run;
    f.executor.run=async()=>{
      const result=await original();
      if(change==='resolved')f.thread.isResolved=true;
      if(change==='truncated')f.thread.truncated=true;
      if(change==='added')f.api.threads=async()=>[structuredClone(f.thread),{...structuredClone(f.thread),id:'T2'}];
      return result;
    };
    assert.equal((await remediate({...f,number:7,apply:true})).status,'failed');
    assert.equal(f.counts().published,0);
  }
});

test('authenticated resolution receipt recovers a failed ledger update without resolving twice',async()=>{
  const f=fixture();await remediate({...f,number:7,apply:true});f.green();
  const rest=f.api.rest,resolve=f.api.resolve;
  let unavailable=true,resolutions=0;
  f.api.resolve=async(...args)=>{resolutions++;await resolve(...args);};
  f.api.rest=async(path,method,body)=>{
    if(method==='POST' && path.endsWith('/replies'))
      f.thread.comments.push({id:444,user:{id:99},body:body.body});
    if(method==='PATCH' && f.thread.isResolved && unavailable)throw new Error('ledger unavailable');
    return rest(path,method,body);
  };
  await assert.rejects(()=>finalize({...f,number:7}),/ledger unavailable/);
  assert.equal(f.thread.isResolved,true);
  unavailable=false;
  assert.equal((await finalize({...f,number:7})).resolved,1);
  assert.equal(resolutions,1);
  assert.equal((await finalize({...f,number:7})).resolved,0);
});

test('finalization stays pending until required checks pass',async()=>{
  const f=fixture();await remediate({...f,number:7,apply:true});
  await finalize({...f,number:7});assert.equal(f.thread.isResolved,false);
  const checks=f.api.checks;
  f.api.checks=async()=>[{name:'Verify',status:'completed',conclusion:'failure',appId:15368}];
  await finalize({...f,number:7});assert.equal(f.thread.isResolved,false);
  f.api.checks=checks;f.green();
  await finalize({...f,number:7});assert.equal(f.thread.isResolved,true);
});

test('one verifier result cannot establish proofs for multiple review threads',async()=>{
 const f=fixture();f.api.threads=async()=>[f.thread,{...f.thread,id:'T2',comments:[{...f.thread.comments[0],id:124}]}];
 assert.equal((await remediate({...f,number:7,apply:true})).status,'unverified');
 assert.deepEqual(f.counts(),{published:0,agentCalls:0});
});

test('pending CI proof blocks another mutation even after new feedback',async()=>{
 const f=fixture();await remediate({...f,number:7,apply:true});
 f.thread.comments[0].body='Another bug';
 assert.equal((await remediate({...f,number:7,apply:true})).status,'pending-ci');
 assert.deepEqual(f.counts(),{published:1,agentCalls:1});
});

test('partial verifier success does not publish or consume a second head',async()=>{
 const f=fixture();f.policy.verifiers=[{id:'first',path:'a.js$',body:'bug'},{id:'second',path:'b.js$',body:'bug'}];
 f.api.threads=async()=>[f.thread,{...f.thread,id:'T2',path:'src/b.js',comments:[{...f.thread.comments[0],id:124}]}];
 let pass=0;f.executor.verify=async()=>({syntax:0,first:pass++?0:1,second:1});
 assert.equal((await remediate({...f,number:7,apply:true})).status,'unverified');
 assert.equal(f.counts().published,0);
});

test('publication uses the freshly verified branch after a rename',async()=>{
 const f=fixture(),run=f.executor.run,publish=f.api.publish;
 f.executor.run=async()=>{const result=await run();f.pr.head.ref='renamed-feature';return result;};
 f.api.publish=async(repo,branch,...rest)=>{assert.equal(branch,'renamed-feature');return publish(repo,branch,...rest);};
 assert.equal((await remediate({...f,number:7,apply:true})).status,'pending-ci');
});

test('interrupted reservation and uncertain publication require reconciliation',async()=>{
 for(const state of [{status:'reserved',stage:'prepare'},{status:'failed',stage:'publish'}]) {
  const f=fixture();
  const record={version:1,type:'attempt',repository:f.policy.repository,pr:7,key:'previous',...state};
  f.api.all=async()=>[{id:55,user:{id:99},body:seal(record,f.api.signingKeys[0])}];
  assert.equal((await remediate({...f,number:7,apply:true})).status,'reconciliation-required');
  assert.deepEqual(f.counts(),{published:0,agentCalls:0});
 }
});

test('rename to a consumer-protected branch blocks publication',async()=>{
 const f=fixture(),run=f.executor.run;f.policy.protectedBranches=['release'];
 f.executor.run=async()=>{const result=await run();f.pr.head.ref='release';return result;};
 assert.equal((await remediate({...f,number:7,apply:true})).status,'failed');
 assert.equal(f.counts().published,0);
});
