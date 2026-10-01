import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, seal, unseal } from '../../runtime/review-remediation/github.mjs';

test('ledger signatures detect tampering and token rotation without exposing the key', () => {
  const record={version:1,repository:'owner/repo',pr:7,key:'fingerprint',status:'reserved'};
  const body=seal(record,'example-test-key');
  assert.deepEqual(unseal(body,'example-test-key').data,record);
  assert.equal(unseal(body,'rotated-key').verified,false);
  assert.equal(unseal(body.replace('v1:','v2:'),'example-test-key'),null);
  assert.ok(!body.includes('example-test-key'));
});
test('REST pagination retains results after the first hundred entries', async () => {
  const paths=[];
  const api=new GitHubClient('token',async url=>{
    paths.push(url);return Response.json(url.includes('page=2')?[{id:101}]:Array.from({length:100},(_,i)=>({id:i+1})));
  });
  assert.equal((await api.all('/repos/owner/repo/issues/7/comments')).length,101);
  assert.equal(paths.length,2);
});
test('publisher uses atomic expectedHeadOid rather than a force push', async () => {
  let request;
  const api=new GitHubClient('token',async (url,init)=>{
    request=JSON.parse(init.body);return Response.json({data:{createCommitOnBranch:{commit:{oid:'new-sha',url:'commit-url'}}}});
  });
  const result=await api.publish('owner/repo','feature','old-sha',[{path:'src/a.js',content:'fixed'},{path:'src/old.js',content:null}]);
  assert.equal(result.oid,'new-sha');
  assert.equal(request.variables.input.expectedHeadOid,'old-sha');
  assert.equal(request.variables.input.branch.branchName,'feature');
  assert.deepEqual(request.variables.input.fileChanges.deletions,[{path:'src/old.js'}]);
  assert.equal(Buffer.from(request.variables.input.fileChanges.additions[0].contents,'base64').toString(),'fixed');
});
test('API and GraphQL errors fail closed', async () => {
  const denied=new GitHubClient('token',async ()=>new Response('sensitive diagnostic',{status:403}));
  await assert.rejects(()=>denied.rest('/repos/owner/repo'),/403/);
  const broken=new GitHubClient('token',async ()=>Response.json({errors:[{message:'bad'}]}));
  await assert.rejects(()=>broken.graphql('query {}'),/GraphQL/);
});


test('same-name check runs retain their distinct workflow provenance',async()=>{
  const api=new GitHubClient('token',async url=>{
    if(url.includes('/check-runs?'))return Response.json({check_runs:[
      {id:2,name:'Verify',status:'completed',conclusion:'success',app:{id:1},head_sha:'sha',check_suite:{id:22}},
      {id:1,name:'Verify',status:'completed',conclusion:'failure',app:{id:1},head_sha:'sha',check_suite:{id:11}}]});
    return Response.json({total_count:3,workflow_runs:[
      {id:2,check_suite_id:22,workflow_id:22,event:'push',head_sha:'sha'},
      {id:1,check_suite_id:11,workflow_id:11,event:'pull_request',head_sha:'sha'},
      {id:3,check_suite_id:33,workflow_id:11,event:'pull_request',head_sha:'sha',status:'queued'}]});
  });
  const checks=await api.checks('owner/repo','sha');
  assert.equal(checks.length,2);
  assert.equal(checks[0].workflow.event,'push');
  assert.equal(checks[1].workflow.event,'pull_request');
  assert.equal(checks[1].conclusion,'failure');
  assert.equal(checks[1].workflow.latestRunId,3);
  assert.notEqual(checks[1].workflow.id,checks[1].workflow.latestRunId);
});


test('ambiguous suites and truncated or oversized workflow inventories fail closed',async()=>{
  for (const data of [{total_count:1,workflow_runs:[]},{total_count:1001,workflow_runs:[]}]) {
    const api=new GitHubClient('token',async url=>Response.json(url.includes('/check-runs?')?{check_runs:[]}:data));
    await assert.rejects(()=>api.checks('owner/repo','sha'),/incomplete/);
  }
  const run={id:1,workflow_id:1,check_suite_id:10,event:'pull_request',head_sha:'sha'};
  const api=new GitHubClient('token',async url=>Response.json(url.includes('/check-runs?')?
    {check_runs:[{id:1,name:'Verify',check_suite:{id:10}}]}:
    {total_count:2,workflow_runs:[run,{...run,id:2}]}));
  assert.equal((await api.checks('owner/repo','sha'))[0].workflow,null);
});
