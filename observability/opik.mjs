import { createUuidV7, validateEvent } from './records.mjs';
import configSchema from '../schemas/opik-config.schema.json' with {type:'json'};

export function validateOpikConfig(config) {
  if(!config || typeof config!=='object' || Array.isArray(config))throw new Error('Invalid telemetry configuration');
  const keys=configSchema.required;
  if(Object.keys(config).some(key=>!keys.includes(key)) || config.schema_version!==1)throw new Error('Unsupported telemetry configuration');
  if(keys.slice(1).some(key=>typeof config[key]!=='string'||!config[key].trim()))throw new Error('Missing telemetry configuration');
  let endpoint;
  try{endpoint=new URL(config.endpoint);}catch{throw new Error('Invalid telemetry endpoint');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('Invalid telemetry endpoint');
  if(!/^[A-Z][A-Z0-9_]*$/.test(config.credential_env))throw new Error('Invalid credential reference');
  if([config.workspace,config.project].some(value=>value.length>256||/[\x00-\x1f\x7f]/.test(value)))throw new Error('Invalid telemetry destination');
  return {...config,endpoint:endpoint.href.replace(/\/+$/,'')};
}

/** Both adapters use the same IDs, terminology, units and unknown-value handling. */
export function opikRecords(event,project) {
  event=structuredClone(event);
  validateEvent(event);
  const trace={id:event.event_id,name:event.event_name,project_name:project,start_time:event.started_at,end_time:event.ended_at,
    thread_id:event.run_id,metadata:event,tags:['agent-platform',event.runtime]};
  const span={id:createUuidV7(Date.parse(event.started_at)),trace_id:trace.id,project_name:project,name:'agent.model',type:'llm',
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
  if(typeof credential!=='string'||!credential)throw new Error('Telemetry credential is unavailable');
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
