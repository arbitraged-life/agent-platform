import { createHash } from 'node:crypto';

export function eligiblePR(pr, policy) {
  if(policy.authorIds!==undefined && (!Array.isArray(policy.authorIds)||policy.authorIds.some(id=>!Number.isSafeInteger(id)||id<1)))return false;
  if(policy.protectedBranches!==undefined && (!Array.isArray(policy.protectedBranches)||policy.protectedBranches.some(name=>typeof name!=='string'||!name)))return false;
  return pr?.state === 'open' && !pr.draft &&
    (!policy.authorIds || policy.authorIds.includes(pr.user?.id)) &&
    !(pr.labels??[]).some(label => label.name === 'review-remediation:hold') &&
    pr.head?.repo?.full_name === policy.repository &&
    /^[0-9a-f]{40}$/.test(pr.head.sha) &&
    !['main', 'master', pr.base?.ref, ...(policy.protectedBranches??[])].includes(pr.head.ref);
}

function reviewer(user, policy) {
  return user?.type === 'Bot' && policy.reviewers.some(r => r.id === user.id && r.login === user.login);
}

export function eligibleEvent(name, event, policy) {
  const actions = {pull_request_review: ['submitted'], pull_request_review_comment: ['created', 'edited']};
  const user = name === 'pull_request_review' ? event.review?.user : event.comment?.user;
  return Boolean(actions[name]?.includes(event.action) &&
    event.repository?.full_name === policy.repository && eligiblePR(event.pull_request, policy) && reviewer(user, policy));
}

export function selectThreads(threads, policy) {
  return threads.filter(t => !t.isResolved && !t.isOutdated && !t.truncated && t.comments.length &&
    reviewer(t.comments[0].user, policy) && t.comments.every(c => reviewer(c.user, policy)));
}

export function fingerprint(pr, threads) {
  const normalized = threads.map(t => ({id: t.id, path: t.path,
    comments: t.comments.map(c => ({id: c.id, user: c.user?.id, body: c.body, updated: c.updated_at}))
      .sort((a,b) => a.id - b.id)})).sort((a,b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify([pr.number, pr.head.sha, normalized])).digest('hex');
}

export function attemptDecision(attempts, key, maxAttempts) {
  if (attempts.some(a => a.key === key)) return 'duplicate';
  return attempts.length >= maxAttempts ? 'budget-exhausted' : 'run';
}

// A verified fix can itself make an old diff thread outdated. That flag is
// neither proof of a fix nor a veto on an otherwise fully verified resolution.
export function canResolve(pr, thread, proof, checks, policy) {
  if (!Number.isSafeInteger(policy.checkWorkflowId) || policy.checkWorkflowId < 1 || !Number.isInteger(policy.checkAppId) || policy.checkAppId<=0 || !eligiblePR(pr, policy) || thread.isResolved || thread.truncated || !proof.verifier ||
      proof.headSha !== pr.head.sha || proof.before !== 1 || proof.after !== 0 ||
      proof.threadHash !== fingerprint(pr, [thread])) return false;
  return policy.requiredChecks.length > 0 && policy.requiredChecks.every(name => {
    const check = checks.find(c => c.name === name && c.appId === policy.checkAppId &&
      c.headSha === pr.head.sha && c.workflow?.workflow_id === policy.checkWorkflowId &&
      c.workflow.event === 'pull_request' && c.workflow.head_sha === pr.head.sha &&
      c.workflow.repository?.full_name === policy.repository &&
      c.workflow.head_repository?.full_name === policy.repository &&
      c.workflow.pull_requests?.some(p => p.number === pr.number && p.head?.sha === pr.head.sha));
    return check?.status === 'completed' && check.conclusion === 'success' &&
      check.appId === policy.checkAppId && Number.isSafeInteger(check.workflow.id) &&
      check.workflow.id === check.workflow.latestRunId && check.workflow.status === 'completed' && check.workflow.conclusion === 'success';
  });
}

export function validateChanges(changes, policy) {
  if (!changes.length || changes.length > policy.maxFiles) throw new Error('empty or excessive patch');
  let bytes = 0;
  const seen = new Set();
  for (const c of changes) {
    const parts = c.path.split('/');
    if (seen.has(c.path) || parts.some(x => !x || x === '.' || x === '..') ||
        /[\\\x00-\x1f\x7f]/.test(c.path) || c.type !== 'file' ||
        /(^|\/)(\.env(?:\..*)?|AGENTS\.md|CLAUDE\.md|GEMINI\.md|secrets?[^/]*|package(?:-lock)?\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|pyproject\.toml|uv\.lock|Pipfile(?:\.lock)?|poetry\.lock|requirements[^/]*\.txt|Cargo\.(?:toml|lock)|go\.(?:mod|sum))$/.test(c.path) ||
        !policy.allowedPrefixes.some(p => p.endsWith('/') ? c.path.startsWith(p) : c.path === p) ||
        policy.deniedPrefixes.some(p => c.path.startsWith(p))) throw new Error(`disallowed change: ${c.path}`);
    seen.add(c.path);
    if (c.content !== null && (typeof c.content !== 'string' || c.content.includes('\0'))) throw new Error('binary patch');
    bytes += Buffer.byteLength(c.content ?? '');
  }
  if (bytes > policy.maxBytes) throw new Error('patch byte limit exceeded');
}

export function assertPolicySafety(policy) {
  if(policy.authorIds!==undefined && (!Array.isArray(policy.authorIds)||policy.authorIds.some(id=>!Number.isSafeInteger(id)||id<1)))throw new Error('Invalid author allowlist');
  if(policy.protectedBranches!==undefined && (!Array.isArray(policy.protectedBranches)||policy.protectedBranches.some(name=>typeof name!=='string'||!name)))throw new Error('Invalid protected branches');
  const checks=policy.requiredChecks;
  if(!Array.isArray(checks) || !checks.length || checks.length>100 ||
      checks.some(name=>typeof name!=='string' || !name.trim() || name.length>256) || new Set(checks).size!==checks.length)
    throw new Error('Invalid required check names');
  const workflows=policy.finalizationWorkflowNames;
  if(!Array.isArray(workflows) || !workflows.length || workflows.length>20 ||
      workflows.some(name=>typeof name!=='string' || !name.trim()) || new Set(workflows).size!==workflows.length)
    throw new Error('Invalid finalization workflow names');
  const ceilings={maxAttempts:2,maxThreads:100,maxFiles:20,maxBytes:1048576,
    agentTimeoutSeconds:600,maxModelRequests:12,maxOutputTokens:4096,checkAppId:Number.MAX_SAFE_INTEGER,checkWorkflowId:Number.MAX_SAFE_INTEGER};
  for(const [key,ceiling] of Object.entries(ceilings)) {
    if(!Number.isSafeInteger(policy[key]) || policy[key]<1 || policy[key]>ceiling)
      throw new Error(`Invalid policy safety limit: ${key}`);
  }
  const credentials={openrouter:'OPENROUTER_API_KEY',openai:'OPENAI_API_KEY'};
  if (!Object.hasOwn(credentials,policy.provider)) throw new Error('Invalid inference provider');
  if (policy.providerEnv!==credentials[policy.provider]) throw new Error('Unsupported inference credential');
  if (typeof policy.model!=='string' || !/^[^/\s]+\/[^\s]+$/.test(policy.model))
    throw new Error('Invalid inference model');
  if (typeof policy.upstreamModel!=='string' || !policy.upstreamModel.trim() ||
      /\s/.test(policy.upstreamModel)) throw new Error('Invalid upstream model');
  let endpoint;
  try { endpoint=new URL(policy.inferenceEndpoint); } catch { throw new Error('Invalid inference endpoint'); }
  if (typeof policy.inferenceEndpoint!=='string' || endpoint.protocol!=='https:' ||
      !endpoint.hostname || endpoint.username || endpoint.password) throw new Error('Invalid inference endpoint');
}
