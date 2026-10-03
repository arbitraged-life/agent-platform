import { validateEvent } from './records.mjs';
import configSchema from '../../schemas/posthog-config.schema.json' with {type:'json'};

export function validatePosthogConfig(config) {
  if(!config || typeof config!=='object' || Array.isArray(config))throw new Error('Invalid PostHog telemetry configuration');
  const keys=configSchema.required;
  if(Object.keys(config).some(key=>!keys.includes(key)) || config.schema_version!==1)throw new Error('Unsupported PostHog telemetry configuration');
  if(keys.slice(1).some(key=>typeof config[key]!=='string'||!config[key].trim()))throw new Error('Missing PostHog telemetry configuration');
  if(!new RegExp(configSchema.properties.endpoint.pattern).test(config.endpoint))throw new Error('Invalid PostHog telemetry endpoint');
  let endpoint;
  try{endpoint=new URL(config.endpoint);}catch{throw new Error('Invalid PostHog telemetry endpoint');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||config.endpoint.includes('?')||config.endpoint.includes('#'))throw new Error('Invalid PostHog telemetry endpoint');
  if(!/^[A-Z][A-Z0-9_]*$/.test(config.credential_env))throw new Error('Invalid PostHog credential reference');
  if(config.distinct_id.length>256||/[\x00-\x1f\x7f]/.test(config.distinct_id))throw new Error('Invalid PostHog distinct ID');
  return {...config,endpoint:endpoint.href.replace(/\/+$/,'')};
}

export function posthogOperationalRecord(event) {
  try { event=structuredClone(event); } catch { throw new Error('Invalid telemetry event snapshot'); }
  validateEvent(event);
  return {
    event:'personal_os_agent_turn_completed',
    properties:{
      schema_version:1,
      source:'agent-platform',
      event_id:event.event_id,
      opik_trace_id:event.event_id,
      runtime:event.runtime,
      run_id:event.run_id,
      task_id:event.task_id,
      agent_id:event.agent_id,
      model_id:event.model_id,
      provider:event.provider,
      status:event.status,
      duration_ms:event.duration_ms,
      attempt:event.attempt,
      tool_calls:event.tool_calls,
      tool_failures:event.tool_failures,
      input_tokens:event.usage.input_tokens,
      output_tokens:event.usage.output_tokens,
      total_tokens:event.usage.total_tokens,
      reasoning_tokens:event.usage.reasoning_tokens,
      cache_read_tokens:event.usage.cache_read_tokens,
      cache_write_tokens:event.usage.cache_write_tokens,
      cost_usd:event.usage.cost_usd,
      timestamp:event.ended_at
    }
  };
}

export function createPosthogExporter(configuration,{environment=process.env,fetcher=fetch}={}) {
  const config=validatePosthogConfig(configuration),token=environment[config.credential_env];
  if(typeof token!=='string'||!token.trim())throw new Error('PostHog telemetry credential is unavailable');
  return async event=>{
    const record=posthogOperationalRecord(event);
    const body={api_key:token,distinct_id:config.distinct_id,event:record.event,properties:record.properties};
    let response;
    try {
      response=await fetcher(`${config.endpoint}/i/v0/e/`,{
        method:'POST',
        redirect:'error',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body),
        signal:AbortSignal.timeout(5000)
      });
    } catch { throw new Error('PostHog telemetry transport failed'); }
    if(!response.ok)throw new Error(`PostHog telemetry ingestion failed (${response.status})`);
    return {status:'delivered',event_id:record.properties.event_id};
  };
}
