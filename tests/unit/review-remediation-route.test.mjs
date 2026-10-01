import test from 'node:test';
import assert from 'node:assert/strict';
import { routeEvent } from '../../runtime/review-remediation/route.mjs';
const policy={finalizationWorkflowNames:['CI'],repository:'owner/repo',authorIds:[1],reviewers:[{id:11,login:'review[bot]'}]};
const pr={number:7,state:'open',user:{id:1},head:{sha:'a'.repeat(40),ref:'feature',repo:{full_name:'owner/repo'}},base:{ref:'main'}};
test('review routing excludes billing notices before any agent work',async()=>{
  const event={repository:{full_name:'owner/repo'},action:'submitted',pull_request:pr,review:{user:{id:11,login:'review[bot]',type:'Bot'}}};
  assert.deepEqual(await routeEvent('pull_request_review',event,policy,{}),[{pr:7,mode:'remediate'}]);
  assert.deepEqual(await routeEvent('issue_comment',event,policy,{}),[]);
});
test('manual dispatch validates sender and numeric pull request input',async()=>{
  const event={sender:{id:1},inputs:{pr:'163',mode:'inspect'}};
  assert.deepEqual(await routeEvent('workflow_dispatch',event,policy,{}),[{pr:163,mode:'inspect'}]);
  assert.deepEqual(await routeEvent('workflow_dispatch',{...event,sender:{id:2}},policy,{}),[]);
  await assert.rejects(()=>routeEvent('workflow_dispatch',{...event,inputs:{pr:'1;bad',mode:'remediate'}},policy,{}));
});
test('only completed CI runs route to the finalizer, never the agent',async()=>{
  const api={all:async()=>[pr]};
  const event={action:'completed',workflow_run:{name:'CI',head_sha:'a'.repeat(40)}};
  assert.deepEqual(await routeEvent('workflow_run',event,policy,api),[{pr:7,mode:'finalize'}]);
  assert.deepEqual(await routeEvent('workflow_run',{...event,workflow_run:{...event.workflow_run,name:'Other'}},policy,api),[]);
});

test('manual dispatch rejects lossy and infinite pull request identifiers',async()=>{
  for(const pr of ['9007199254740993','9'.repeat(400)])
    await assert.rejects(()=>routeEvent('workflow_dispatch',{sender:{id:1},inputs:{pr,mode:'inspect'}},policy,{}),/Invalid manual dispatch/);
});
