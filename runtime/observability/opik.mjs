import { createHash } from 'node:crypto';
import { validateEvent } from './records.mjs';
import configSchema from '../../schemas/opik-config.schema.json' with {type:'json'};

export function validateOpikConfig(config) {
  if(!config || typeof config!=='object' || Array.isArray(config))throw new Error('Invalid telemetry configuration');
  const keys=configSchema.required;
  if(Object.keys(config).some(key=>!keys.includes(key)) || config.schema_version!==1)throw new Error('Unsupported telemetry configuration');
  if(keys.slice(1).some(key=>typeof config[key]!=='string'||!config[key].trim()))throw new Error('Missing telemetry configuration');
  if(!new RegExp(configSchema.properties.endpoint.pattern).test(config.endpoint))throw new Error('Invalid telemetry endpoint');
  let endpoint;
  try{endpoint=new URL(config.endpoint);}catch{throw new Error('Invalid telemetry endpoint');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||config.endpoint.includes('?')||config.endpoint.includes('#'))throw new Error('Invalid telemetry endpoint');
  if(!/^[A-Z][A-Z0-9_]*$/.test(config.credential_env))throw new Error('Invalid credential reference');
  if([config.workspace,config.project].some(value=>value.length>256||/[\x00-\x1f\x7f]/.test(value)))throw new Error('Invalid telemetry destination');
  return {...config,endpoint:endpoint.href.replace(/\/+$/,'')};
}

// Preserve the event timestamp; derive stable UUIDv7 random bits for its span.
function spanId(eventId) {
  const bytes=createHash('sha256').update('agent-platform:agent.model:' + eventId.toLowerCase()).digest().subarray(0,16);
  Buffer.from(eventId.replaceAll('-',''),'hex').copy(bytes,0,0,6);
  bytes[6]=(bytes[6]&0x0f)|0x70;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/** Both adapters use the same IDs, terminology, units and unknown-value handling. */
export function opikRecords(event,project) {
  try {event=structuredClone(event);} catch {throw new Error('Invalid telemetry event snapshot');}
  validateEvent(event);
  const trace={id:event.event_id,name:event.event_name,project_name:project,start_time:event.started_at,end_time:event.ended_at,
    thread_id:event.run_id,metadata:event,tags:['agent-platform',event.runtime]};
  const span={id:spanId(event.event_id),trace_id:trace.id,project_name:project,name:'agent.model',type:'llm',
    start_time:event.started_at,end_time:event.ended_at,metadata:event};
  if(event.provider!==null)span.provider=event.provider;
  if(event.model_id!==null)span.model=event.model_id;
  const usage={};
  for(const [target,source] of [['prompt_tokens','input_tokens'],['completion_tokens','output_tokens'],['total_tokens','total_tokens']])
    if(event.usage[source]!==null)usage[target]=event.usage[source];
  if(Object.keys(usage).length)span.usage=usage;
  return {trace,span};
}

export function createOpikExporter(configuration,{environment=process.env,fetcher=fetch}={}) {
  const config=validateOpikConfig(configuration),credential=environment[config.credential_env];
  if(typeof credential!=='string'||!credential.trim())throw new Error('Telemetry credential is unavailable');
  return async event=>{
    const records=opikRecords(event,config.project);
    for(const [resource,record] of [['traces',records.trace],['spans',records.span]]) {
      let response;
      try {
        response=await fetcher(`${config.endpoint}/v1/private/${resource}`,{method:'POST',redirect:'error',
          headers:{'Content-Type':'application/json','Comet-Workspace':config.workspace,authorization:credential},
          body:JSON.stringify(record),signal:AbortSignal.timeout(5000)});
      } catch {throw new Error('Telemetry transport failed');}
      // Provider bodies and exceptions can contain credentials or private request data.
      if(!response.ok)throw new Error(`Telemetry ingestion failed (${response.status})`);
    }
    return {status:'delivered',event_id:records.trace.id};
  };
}
