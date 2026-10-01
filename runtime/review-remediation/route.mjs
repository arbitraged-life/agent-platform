import { eligibleEvent, eligiblePR } from './policy.mjs';

export async function routeEvent(name,event,policy,api) {
  if (name === 'workflow_dispatch') {
    if (!policy.authorIds?.includes(event.sender?.id)) return [];
    if (!/^[1-9][0-9]*$/.test(event.inputs?.pr??'') ||
        !['inspect','remediate','finalize'].includes(event.inputs?.mode)) throw new Error('Invalid manual dispatch');
    return [{pr:Number(event.inputs.pr),mode:event.inputs.mode}];
  }
  if (name === 'workflow_run') {
    const run=event.workflow_run;
    if (event.action!=='completed' || !policy.finalizationWorkflowNames?.includes(run?.name) || !/^[a-f0-9]{40}$/.test(run.head_sha)) return [];
    const prs=await api.all(`/repos/${policy.repository}/commits/${run.head_sha}/pulls`);
    return prs.filter(pr=>eligiblePR(pr,policy)).map(pr=>({pr:pr.number,mode:'finalize'}));
  }
  return eligibleEvent(name,event,policy) ? [{pr:event.pull_request.number,mode:'remediate'}] : [];
}
