import { eligiblePR, selectThreads, fingerprint, attemptDecision, canResolve, validateChanges } from './policy.mjs';
import { seal, unseal } from './github.mjs';

async function context(api, policy, number) {
  const pr = await api.rest(`/repos/${policy.repository}/pulls/${number}`);
  if (!eligiblePR(pr, policy)) throw new Error('PR is not eligible');
  const identity = await api.rest('/user');
  const comments = await api.all(`/repos/${policy.repository}/issues/${number}/comments`);
  const ledger = comments.flatMap(comment => {
    const record = unseal(comment.body, api.token);
    return comment.user.id === identity.id && record?.verified && record.data.version === 1 &&
      record.data.repository === policy.repository && record.data.pr === number && record.data.type === 'attempt'
      ? [{...record, commentId:comment.id}] : [];
  });
  return {pr, identity, ledger};
}

function visibleThread(thread, identity, token) {
  return {...thread, comments:thread.comments.filter(c => {
    const signed = c.user.id === identity.id && unseal(c.body, token);
    return !(signed?.verified && signed.data.type === 'resolution' && signed.data.threadId === thread.id);
  })};
}

function recordBody(record, token) {
  return `Review remediation: **${record.status}**. Attempt ${record.attempt}. ` +
    `Selected ${record.threadCount} review thread(s); verified ${record.proofs?.length ?? 0}. ` +
    'Unverified findings remain open. No automatic merge or deployment.\n\n' + seal(record, token);
}

async function update(api, repository, id, record) {
  await api.rest(`/repos/${repository}/issues/comments/${id}`, 'PATCH', {body:recordBody(record,api.token)});
}

function verifierFor(thread, policy) {
  return policy.verifiers.find(v => new RegExp(v.path).test(thread.path) && new RegExp(v.body,'i').test(thread.comments[0].body));
}

export async function remediate({api, policy, executor, number, apply=false}) {
  const {pr,identity,ledger} = await context(api,policy,number);
  const all = (await api.threads(policy.repository,number)).map(t=>visibleThread(t,identity,api.token));
  const threads = selectThreads(all,policy);
  if (!threads.length) return {status:'no-feedback',selected:0};
  if (threads.length > policy.maxThreads) return {status:'thread-limit',selected:threads.length};
  if (Buffer.byteLength(JSON.stringify(threads)) > 98304) return {status:'feedback-limit',selected:threads.length};
  const key = fingerprint(pr,threads);
  const decision = attemptDecision(ledger.map(r=>r.data),key,policy.maxAttempts);
  if (decision !== 'run') return {status:decision,selected:threads.length};
  if (!apply) return {status:'eligible',selected:threads.length,headSha:pr.head.sha,
    threads:threads.map(t=>({id:t.id,path:t.path,reviewer:t.comments[0].user.login,verifier:verifierFor(t,policy)?.id??null}))};
  const record = {version:1,type:'attempt',repository:policy.repository,pr:number,key,
    headSha:pr.head.sha,attempt:ledger.length+1,status:'reserved',threadCount:threads.length,proofs:[],createdAt:new Date().toISOString()};
  const reservation = await api.rest(`/repos/${policy.repository}/issues/${number}/comments`,'POST',{body:recordBody(record,api.token)});
  let workspace;
  try {
    record.stage='prepare';
    workspace = await executor.prepare(pr);
    record.stage='verify-before';
    const before = await executor.verify(workspace);
    record.before=before;
    const actionable = threads.filter(t=>before[verifierFor(t,policy)?.id] === 1);
    if (!actionable.length) record.status = 'unverified';
    else {
      record.stage='agent';
      const agent = await executor.run(workspace,actionable,pr);
      if (agent.code !== 0) record.status = agent.code === 124 ? 'agent-timeout' : 'agent-failed';
      else {
        record.stage='generate-and-verify';
        const changes = await executor.changes(workspace);
        const after = await executor.verify(workspace);
        record.after=after;
        const proofs = actionable.flatMap(t=>{
          const id=verifierFor(t,policy).id;
          return before[id]===1 && after[id]===0 ? [{threadId:t.id,rootCommentId:t.comments[0].id,verifier:id,before:1,after:0}] : [];
        });
        const lostPassingCheck=Object.entries(before).some(([name,status])=>status===0 && after[name]!==0);
        if (!proofs.length || after.syntax !== 0 || lostPassingCheck) record.status='unverified';
        else {
          validateChanges(changes,policy);
          const credentials=[api.token,process.env[policy.providerEnv]].filter(Boolean);
          if(changes.some(c=>credentials.some(secret=>c.content?.includes(secret))))
            throw new Error('Credential material detected in proposed patch');
          record.stage='publish';
          const current = await api.rest(`/repos/${policy.repository}/pulls/${number}`);
          const fresh = (await api.threads(policy.repository,number)).map(t=>visibleThread(t,identity,api.token));
          const matching = fresh.filter(t=>threads.some(old=>old.id===t.id));
          if (!eligiblePR(current,policy) || current.head.sha!==pr.head.sha || fingerprint(current,matching)!==key)
            throw new Error('PR or discussion changed during remediation');
          const commit = await api.publish(policy.repository,pr.head.ref,pr.head.sha,changes);
          const published = {...pr,head:{...pr.head,sha:commit.oid}};
          record.status='pending-ci';record.publishedSha=commit.oid;
          record.proofs=proofs.map(p=>({...p,headSha:commit.oid,threadHash:fingerprint(published,[threads.find(t=>t.id===p.threadId)])}));
        }
      }
    }
  } catch (error) {
    record.status='failed';
    // Detailed subprocess/model output is not copied into public comments.
    record.failure=error.name;
  } finally {
    await update(api,policy.repository,reservation.id,record);
    if (workspace) await executor.cleanup(workspace);
  }
  return {status:record.status,stage:record.stage,selected:threads.length,publishedSha:record.publishedSha,verified:record.proofs.length,before:record.before,after:record.after};
}

export async function finalize({api,policy,number}) {
  const {pr,identity,ledger}=await context(api,policy,number);
  const checks=await api.checks(policy.repository,pr.head.sha);
  let resolved=0;
  for (const entry of ledger.filter(r=>r.verified && r.data.status==='pending-ci' && r.data.publishedSha===pr.head.sha)) {
    const record=entry.data;
    for (const proof of record.proofs) {
      if (proof.resolved) continue;
      const current=await api.rest(`/repos/${policy.repository}/pulls/${number}`);
      const rawThread=(await api.threads(policy.repository,number)).find(t=>t.id===proof.threadId);
      const thread=rawThread && visibleThread(rawThread,identity,api.token);
      if (!thread || !canResolve(current,thread,proof,checks,policy)) continue;
      const body=`Addressed in ${proof.headSha}. Independent verifier \`${proof.verifier}\` failed before the change and passed afterward; required CI passed for this exact commit.\n\n`+
        seal({type:'resolution',threadId:thread.id,headSha:proof.headSha},api.token);
      const alreadyReplied=rawThread.comments.some(c=>{
        const receipt=c.user.id===identity.id && unseal(c.body,api.token);
        return receipt?.verified && receipt.data.type==='resolution' && receipt.data.threadId===thread.id && receipt.data.headSha===proof.headSha;
      });
      if(!alreadyReplied)await api.rest(`/repos/${policy.repository}/pulls/${number}/comments/${proof.rootCommentId}/replies`,'POST',{body});
      const last=await api.rest(`/repos/${policy.repository}/pulls/${number}`);
      const lastThread=(await api.threads(policy.repository,number)).map(t=>visibleThread(t,identity,api.token)).find(t=>t.id===proof.threadId);
      const latestChecks=await api.checks(policy.repository,last.head.sha);
      if (!lastThread || !canResolve(last,lastThread,proof,latestChecks,policy)) continue;
      await api.resolve(thread.id);proof.resolved=true;resolved++;
      await update(api,policy.repository,entry.commentId,record);
    }
    if (record.proofs.every(p=>p.resolved)) {record.status='complete';await update(api,policy.repository,entry.commentId,record);}
  }
  return {status:resolved?'resolved':'pending-or-unverified',resolved};
}
