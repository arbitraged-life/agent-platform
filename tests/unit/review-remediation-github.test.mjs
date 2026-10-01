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
