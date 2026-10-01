import { createHmac, timingSafeEqual } from 'node:crypto';

const MARKER = /<!-- review-remediation:v1:([A-Za-z0-9+/=]+):([a-f0-9]{64}) -->/;

export function seal(data, key) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64');
  const signature = createHmac('sha256', key).update(payload).digest('hex');
  return `<!-- review-remediation:v1:${payload}:${signature} -->`;
}

export function unseal(body, key) {
  if(Array.isArray(key)) {
    const records=key.map(value=>unseal(body,value));
    return records.find(record=>record?.verified)??records.find(Boolean)??null;
  }
  const match = body.match(MARKER);
  if (!match) return null;
  try {
    const expected = createHmac('sha256', key).update(match[1]).digest();
    return {data: JSON.parse(Buffer.from(match[1], 'base64').toString()),
      verified: timingSafeEqual(expected, Buffer.from(match[2], 'hex'))};
  } catch { return null; }
}

export class GitHubClient {
  constructor(token, fetcher = fetch, {signingKeys=[]} = {}) {
    if (!token) throw new Error('GitHub credential is missing');
    this.token = token;
    this.signingKeys = signingKeys;
    this.fetcher = fetcher;
  }

  async request(path, method = 'GET', body) {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method, headers: {Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} request failed (${response.status})`);
    return response;
  }

  async rest(path, method = 'GET', body) {
    const response = await this.request(path, method, body);
    return response.status === 204 ? null : response.json();
  }

  async graphql(query, variables = {}) {
    const result = await this.rest('/graphql', 'POST', {query, variables});
    if (result.errors?.length || !result.data) throw new Error('GitHub GraphQL request failed');
    return result.data;
  }

  async all(path) {
    const results = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await this.rest(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('Expected a paginated GitHub array');
      results.push(...rows);
      if (rows.length < 100) return results;
    }
    throw new Error('GitHub pagination safety limit reached');
  }

  async threads(repository, number) {
    const [owner, name] = repository.split('/');
    const comments = new Map((await this.all(`/repos/${repository}/pulls/${number}/comments`)).map(c => [c.id, c]));
    const threads = [];
    let after = null;
    do {
      const data = await this.graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){
        repository(owner:$owner,name:$name){pullRequest(number:$number){
          reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{
            id isResolved isOutdated path comments(first:100){pageInfo{hasNextPage} nodes{databaseId}}
          }}
        }}
      }`, {owner, name, number, after});
      const connection = data.repository.pullRequest.reviewThreads;
      for (const t of connection.nodes) {
        const ids = t.comments.nodes.map(c => c.databaseId);
        threads.push({...t, truncated: t.comments.pageInfo.hasNextPage || ids.some(id => !comments.has(id)),
          comments: ids.map(id => comments.get(id)).filter(Boolean)});
      }
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      if (threads.length > 10000) throw new Error('Thread pagination safety limit reached');
    } while (after);
    return threads;
  }

  async checks(repository, sha) {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.rest(`/repos/${repository}/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`);
      result.push(...data.check_runs);
      if (data.check_runs.length < 100) {
        const runs = [];
        for (let runPage = 1; runPage <= 10; runPage++) {
          const data = await this.rest(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=${runPage}`);
          if (!Array.isArray(data.workflow_runs) || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || data.total_count > 1000) throw new Error('Workflow provenance is incomplete');
          runs.push(...data.workflow_runs);
          if (runs.length === data.total_count) break;
          if (data.workflow_runs.length < 100 || runs.length > data.total_count) throw new Error('Workflow provenance is incomplete');
          if (runPage === 10) throw new Error('Workflow provenance pagination limit reached');
        }
        const suites = new Map();
        for (const run of runs) {
          const matching = runs.filter(candidate => candidate.check_suite_id === run.check_suite_id);
          if (matching.length !== 1) continue;
          const latestRunId = Math.max(...runs.filter(candidate =>
            candidate.workflow_id === run.workflow_id && candidate.event === 'pull_request' && candidate.head_sha === sha
          ).map(candidate => candidate.id));
          suites.set(run.check_suite_id, {...run, latestRunId});
        }
        return result.sort((a,b) => b.id-a.id).map(check => ({
          name:check.name, status:check.status, conclusion:check.conclusion, appId:check.app?.id,
          headSha:check.head_sha, workflow:suites.get(check.check_suite?.id) ?? null,
        }));
      }
    }
    throw new Error('Check pagination safety limit reached');
  }

  async publish(repository, branch, expectedHeadOid, changes) {
    const fileChanges = {
      additions: changes.filter(c => c.content !== null).map(c => ({path:c.path,contents:Buffer.from(c.content).toString('base64')})),
      deletions: changes.filter(c => c.content === null).map(c => ({path:c.path})),
    };
    const data = await this.graphql(`mutation($input:CreateCommitOnBranchInput!){
      createCommitOnBranch(input:$input){commit{oid url}}
    }`, {input:{branch:{repositoryNameWithOwner:repository,branchName:branch},expectedHeadOid,fileChanges,
      message:{headline:'fix: address verified review feedback',body:'Bounded review-remediation run. No automatic merge or deployment.'}}});
    return data.createCommitOnBranch.commit;
  }

  async resolve(threadId) {
    const data = await this.graphql(`mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`, {id:threadId});
    if (!data.resolveReviewThread.thread.isResolved) throw new Error('Thread resolution not confirmed');
  }

  async archive(repository, sha) {
    const response = await this.request(`/repos/${repository}/tarball/${sha}`);
    if (!['api.github.com','codeload.github.com'].includes(new URL(response.url).hostname)) throw new Error('Unexpected archive origin');
    if(!response.body)throw new Error('Repository archive body is missing');
    const reader=response.body.getReader(),chunks=[];
    let size=0;
    try {
      for(;;) {
        const {value,done}=await reader.read();
        if(done)return Buffer.concat(chunks,size);
        size+=value.byteLength;
        if(size>100*1024*1024)throw new Error('Repository archive exceeds size limit');
        chunks.push(Buffer.from(value));
      }
    } catch(error) {
      await reader.cancel().catch(()=>{});
      throw error;
    } finally { reader.releaseLock(); }
  }
}
