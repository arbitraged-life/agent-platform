import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eligibleEvent, selectThreads, fingerprint, attemptDecision, canResolve, validateChanges, assertPolicySafety } from '../../runtime/review-remediation/policy.mjs';

const policy = {
  repository: 'owner/project', maxAttempts: 2, maxFiles: 8, maxBytes: 10000,
  reviewers: [{id: 11, login: 'review-a[bot]'}, {id: 22, login: 'review-b[bot]'}],
  allowedPrefixes: ['src/', 'tests/'], deniedPrefixes: ['.github/', 'src/policy/'],
  requiredChecks: ['Verify'],checkAppId:15368,checkWorkflowId:123,
};
const safePolicy = {requiredChecks:['Verify'],finalizationWorkflowNames:['CI'],maxAttempts:2,maxThreads:12,maxFiles:8,maxBytes:131072,agentTimeoutSeconds:390,
  maxModelRequests:12,maxOutputTokens:4096,checkAppId:15368,checkWorkflowId:123,provider:'openrouter',
  providerEnv:'OPENROUTER_API_KEY',model:'openrouter/qwen/qwen3-coder',upstreamModel:'qwen/qwen3-coder',
  inferenceEndpoint:'https://openrouter.ai/api/v1/chat/completions'};
const pr = {number: 7, state: 'open', draft: false, head: {sha: 'a'.repeat(40), ref: 'feature', repo: {full_name: policy.repository}}, base: {ref: 'main'}};
const root = {id: 123, user: {id: 11, login: 'review-a[bot]', type: 'Bot'}, body: 'Fix the bug', updated_at: '2026-01-01', in_reply_to_id: null};
const thread = {id: 'T1', isResolved: false, isOutdated: false, path: 'src/a.js', comments: [root]};
const reviewEvent = {action: 'submitted', repository: {full_name: policy.repository}, pull_request: pr, review: {user: root.user}};

test('accepts allowlisted review submissions, rejects notices and forged identities', () => {
  assert.equal(eligibleEvent('pull_request_review', reviewEvent, policy), true);
  assert.equal(eligibleEvent('issue_comment', reviewEvent, policy), false);
  assert.equal(eligibleEvent('pull_request_review', {...reviewEvent, action:'dismissed'}, policy), false);
  assert.equal(eligibleEvent('pull_request_review', {...reviewEvent, review:{user:{...root.user,id:99}}}, policy), false);
});
test('rejects forks, drafts, closed PRs and protected head branches', () => {
  for (const change of [{draft:true}, {state:'closed'}, {head:{...pr.head,ref:'main'}}, {head:{...pr.head,repo:{full_name:'other/project'}}}]) {
    assert.equal(eligibleEvent('pull_request_review', {...reviewEvent,pull_request:{...pr,...change}}, policy), false);
  }
});
test('selects mixed allowlisted findings and excludes stale or human-discussed threads', () => {
  const second = {...thread,id:'T2',comments:[{...root,id:124,user:{id:22,login:'review-b[bot]',type:'Bot'}}]};
  const human = {...thread,id:'H',comments:[root,{id:125,user:{id:3,login:'human',type:'User'},body:'Do not change this',updated_at:'now'}]};
  const outsider = {...thread,id:'N',comments:[{...root,user:{id:88,login:'billing[bot]',type:'Bot'}}]};
  assert.deepEqual(selectThreads([thread,second,human,outsider,{...thread,isOutdated:true},{...thread,isResolved:true}],policy).map(x=>x.id), ['T1','T2']);
});
test('feedback fingerprint is stable under order but changes with edits or new replies', () => {
  const t2={...thread,id:'T2'};
  assert.equal(fingerprint(pr,[thread,t2]), fingerprint(pr,[t2,thread]));
  assert.notEqual(fingerprint(pr,[thread]), fingerprint(pr,[{...thread,comments:[{...root,body:'Changed'}]}]));
  assert.notEqual(fingerprint(pr,[thread]), fingerprint({...pr,head:{...pr.head,sha:'b'.repeat(40)}},[thread]));
});
test('deduplicates attempts and caps the entire PR rather than resetting after a bot push', () => {
  assert.equal(attemptDecision([{key:'x'}],'x',2),'duplicate');
  assert.equal(attemptDecision([{key:'x'},{key:'y'}],'z',2),'budget-exhausted');
  assert.equal(attemptDecision([{key:'x'}],'z',2),'run');
});
test('resolve requires same published head, unchanged discussion, regression proof and successful CI', () => {
  const proof={headSha:pr.head.sha,threadHash:fingerprint(pr,[thread]),before:1,after:0,verifier:'regression'};
  const checks=[{name:'Verify',status:'completed',conclusion:'success',appId:15368,headSha:pr.head.sha,workflow:{workflow_id:123,id:10,latestRunId:10,status:'completed',conclusion:'success',event:'pull_request',head_sha:pr.head.sha,repository:{full_name:policy.repository},head_repository:{full_name:policy.repository},pull_requests:[{number:pr.number,head:{sha:pr.head.sha}}]}}];
  assert.equal(canResolve(pr,thread,proof,checks,policy),true);
  for (const patch of [{headSha:'b'.repeat(40)},{before:0},{before:2},{after:1},{verifier:null},{threadHash:'changed'}]) {
    assert.equal(canResolve(pr,thread,{...proof,...patch},checks,policy),false);
  }
  for (const bad of [[],[{name:'Verify',status:'in_progress',conclusion:null}],[{name:'Verify',status:'completed',conclusion:'failure'}],[{name:'Verify',status:'completed',conclusion:'skipped'}]]) {
    assert.equal(canResolve(pr,thread,proof,bad,policy),false);
  }
});
test('changed discussions block resolution; outdated alone is never success', () => {
  const proof={headSha:pr.head.sha,threadHash:fingerprint(pr,[thread]),before:1,after:0,verifier:'v'};
  const checks=[{name:'Verify',status:'completed',conclusion:'success',appId:15368,headSha:pr.head.sha,workflow:{workflow_id:123,id:10,latestRunId:10,status:'completed',conclusion:'success',event:'pull_request',head_sha:pr.head.sha,repository:{full_name:policy.repository},head_repository:{full_name:policy.repository},pull_requests:[{number:pr.number,head:{sha:pr.head.sha}}]}}];
  assert.equal(canResolve(pr,{...thread,comments:[root,{...root,id:999,body:'Still broken'}]},proof,checks,policy),false);
  assert.equal(canResolve(pr,{...thread,isOutdated:true},{...proof,before:0},checks,policy),false);
});
test('publisher rejects protected paths, symlinks, excessive files and binary content', () => {
  const good={path:'src/a.js',content:'export const a = 1;',type:'file'};
  assert.doesNotThrow(()=>validateChanges([good],policy));
  for (const bad of [{...good,path:'.github/workflows/x.yml'},{...good,path:'src/policy/x.js'},{...good,path:'src/../secrets.env'},{...good,path:'/src/a.js'},{...good,type:'symlink'},{...good,content:'a\0b'},{...good,content:'x'.repeat(10001)}]) {
    assert.throws(()=>validateChanges([bad],policy));
  }
  assert.throws(()=>validateChanges(Array.from({length:9},(_,i)=>({...good,path:`src/${i}.js`})),policy));
});

test('repository author allowlist and hold label stop automatic work',()=>{
  const guarded={...policy,authorIds:[77]};
  const event={...reviewEvent,pull_request:{...pr,user:{id:77}}};
  assert.equal(eligibleEvent('pull_request_review',event,guarded),true);
  assert.equal(eligibleEvent('pull_request_review',{...event,pull_request:{...event.pull_request,user:{id:88}}},guarded),false);
  assert.equal(eligibleEvent('pull_request_review',{...event,pull_request:{...event.pull_request,labels:[{name:'review-remediation:hold'}]}},guarded),false);
});
test('CI check identity must match the configured GitHub App',()=>{
  const guarded={...policy,checkAppId:15368};
  const proof={headSha:pr.head.sha,threadHash:fingerprint(pr,[thread]),before:1,after:0,verifier:'v'};
  assert.equal(canResolve(pr,thread,proof,[{name:'Verify',status:'completed',conclusion:'success',appId:999}],guarded),false);
  assert.equal(canResolve(pr,thread,proof,[{name:'Verify',status:'completed',conclusion:'success',appId:15368,headSha:pr.head.sha,workflow:{workflow_id:123,id:10,latestRunId:10,status:'completed',conclusion:'success',event:'pull_request',head_sha:pr.head.sha,repository:{full_name:policy.repository},head_repository:{full_name:policy.repository},pull_requests:[{number:pr.number,head:{sha:pr.head.sha}}]}}],guarded),true);
});

test('an allowed file name is exact rather than an arbitrary path prefix',()=>{
  assert.throws(()=>validateChanges([{path:'src/config.json.evil',type:'file',content:'x'}],{...policy,allowedPrefixes:['src/config.json']}));
});

test('an unspecified check App identity can never authorize resolution',()=>{
  const proof={headSha:pr.head.sha,threadHash:fingerprint(pr,[thread]),before:1,after:0,verifier:'v'};
  assert.equal(canResolve(pr,thread,proof,[{name:'Verify',status:'completed',conclusion:'success',appId:15368,headSha:pr.head.sha,workflow:{workflow_id:123,id:10,latestRunId:10,status:'completed',conclusion:'success',event:'pull_request',head_sha:pr.head.sha,repository:{full_name:policy.repository},head_repository:{full_name:policy.repository},pull_requests:[{number:pr.number,head:{sha:pr.head.sha}}]}}],{...policy,checkAppId:undefined}),false);
});

test('safety ceilings reject absent, non-finite, fractional and negative budgets',async()=>{
  const {assertPolicySafety}=await import('../../runtime/review-remediation/policy.mjs');
  const p=safePolicy;
  assert.equal(typeof assertPolicySafety,'function');
  assert.doesNotThrow(()=>assertPolicySafety(p));
  for(const key of Object.keys(p).filter(key=>typeof p[key]==='number')) {
    for(const value of [undefined,NaN,Infinity,0,-1,1.5]) {
      assert.throws(()=>assertPolicySafety({...p,[key]:value}),key+':'+value);
    }
  }
  assert.throws(()=>assertPolicySafety({...p,maxAttempts:3}));
  assert.throws(()=>assertPolicySafety({...p,maxModelRequests:13}));
});

test('malformed inference policy fails at startup before GitHub credentials or attempt reservation',async()=>{
  const {assertPolicySafety}=await import('../../runtime/review-remediation/policy.mjs');
  const invalid=[
    [{providerEnv:undefined},/Unsupported inference credential/],
    [{providerEnv:'GH_TOKEN'},/Unsupported inference credential/],
    [{providerEnv:'OPENAI_API_KEY'},/Unsupported inference credential/],
    [{provider:undefined},/Invalid inference provider/],
    [{provider:'other'},/Invalid inference provider/],
    [{provider:'anthropic',providerEnv:'ANTHROPIC_API_KEY'},/Invalid inference provider/],
    [{model:undefined},/Invalid inference model/],
    [{model:'openrouter/'},/Invalid inference model/],
    [{upstreamModel:' '},/Invalid upstream model/],
    [{inferenceEndpoint:'http://openrouter.ai/api/v1/chat/completions'},/Invalid inference endpoint/],
    [{inferenceEndpoint:'not-a-url'},/Invalid inference endpoint/],
  ];
  for(const [change,reason] of invalid)assert.throws(()=>assertPolicySafety({...safePolicy,...change}),reason);
  const dir=await mkdtemp(join(tmpdir(),'review-policy-startup-'));
  try {
    const config=join(dir,'policy.json');
    await writeFile(config,JSON.stringify({...safePolicy,providerEnv:'GH_TOKEN'}));
    const run=promisify(execFile);
    await assert.rejects(()=>run(process.execPath,
      [new URL('../../scripts/review/remediate.mjs',import.meta.url).pathname,'--config',config,'--pr','7','--mode','remediate'],
      {env:{...process.env,GH_TOKEN:''}}),error=>{
      assert.match(error.stderr,/Unsupported inference credential/);
      assert.doesNotMatch(error.stderr,/GitHub credential is missing/);
      return true;
    });
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('agent adapter selector is independent of credential provider',()=>{
  assert.doesNotThrow(()=>assertPolicySafety({...safePolicy,model:'review-proxy/qwen/qwen3-coder'}));
});

test('malformed author allowlists and configured protected heads fail closed',()=>{
 const event={...reviewEvent,pull_request:{...pr,user:{id:7}}};
 for(const authorIds of ['77',77,null,{},[7.5],['7']])assert.equal(eligibleEvent('pull_request_review',event,{...policy,authorIds}),false);
 assert.equal(eligibleEvent('pull_request_review',event,{...policy,authorIds:[7]}),true);
 assert.equal(eligibleEvent('pull_request_review',event,{...policy,protectedBranches:[pr.head.ref]}),false);
});


test('resolution binds named checks to current PR workflow and successful rerun',()=>{
  const proof={headSha:pr.head.sha,threadHash:fingerprint(pr,[thread]),before:1,after:0,verifier:'v'};
  const trusted={name:'Verify',status:'completed',conclusion:'failure',appId:15368,headSha:pr.head.sha,
    workflow:{workflow_id:123,id:10,latestRunId:10,status:'completed',conclusion:'success',event:'pull_request',head_sha:pr.head.sha,
      repository:{full_name:policy.repository},head_repository:{full_name:policy.repository},pull_requests:[{number:7,head:{sha:pr.head.sha}}]}};
  const success={...trusted,conclusion:'success'};
  assert.equal(canResolve(pr,thread,proof,[success],policy),true);
  for(const change of [{workflow_id:999},{event:'push'},{event:'workflow_dispatch'},{pull_requests:[]},
    {pull_requests:[{number:8,head:{sha:pr.head.sha}}]},{repository:{full_name:'other/repo'}},{head_repository:{full_name:'other/repo'}},{head_sha:'b'.repeat(40)},
    {status:'in_progress',conclusion:null},{conclusion:'failure'},{latestRunId:11}]) {
    assert.equal(canResolve(pr,thread,proof,[{...success,workflow:{...success.workflow,...change}},trusted],policy),false);
  }
  assert.equal(canResolve(pr,thread,proof,[{...success,workflow:null}],policy),false);
});

test('required checks are validated before remediation starts',()=>{
  for(const requiredChecks of [undefined,null,{},'Verify',[],[''],[' '],['Verify','Verify'],[3],['x'.repeat(257)],Array.from({length:101},(_,i)=>String(i))]) {
    assert.throws(()=>assertPolicySafety({...safePolicy,requiredChecks}),/required check/);
  }
  assert.doesNotThrow(()=>assertPolicySafety({...safePolicy,requiredChecks:['Verify','Test (linux)']}));
});
