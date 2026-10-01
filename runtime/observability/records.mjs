import { randomBytes } from 'node:crypto';
import schema from '../../schemas/telemetry-event.schema.json' with {type:'json'};

export function createUuidV7(nowMs=Date.now()) {
  if(!Number.isSafeInteger(nowMs) || nowMs<0 || nowMs>0xffffffffffff)throw new Error('Invalid event timestamp');
  const bytes=randomBytes(16);
  let timestamp=BigInt(nowMs);
  for(let i=5;i>=0;i--){bytes[i]=Number(timestamp&0xffn);timestamp>>=8n;}
  bytes[6]=(bytes[6]&0x0f)|0x70;bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function measurement(value,integer=true) {
  return typeof value==='number' && Number.isFinite(value) && value>=0 && (!integer || Number.isSafeInteger(value)) ? value : null;
}

/** Reported totals stay authoritative: cache/reasoning inclusion differs by runtime. */
export function normalizeUsage({input,output,total,reasoning,cacheRead,cacheWrite,costUsd}={}) {
  return {input_tokens:measurement(input),output_tokens:measurement(output),total_tokens:measurement(total),
    reasoning_tokens:measurement(reasoning),cache_read_tokens:measurement(cacheRead),cache_write_tokens:measurement(cacheWrite),
    cost_usd:measurement(costUsd,false)};
}

function identifier(value,label,required=false) {
  if(value===undefined || value===null){if(required)throw new Error(`Missing ${label}`);return null;}
  if(typeof value!=='string' || !value.trim() || value.length>256 || /[\x00-\x1f\x7f]/.test(value))throw new Error(`Invalid ${label}`);
  return value;
}

/** Structured metadata excludes prompts, responses, paths, tool arguments and raw errors. */
export function turnEvent({runtime,runId,taskId,agentId,modelId,provider,startedMs,endedMs,status='succeeded',attempt=1,
  usage={},toolCalls=0,toolFailures=0,eventId}={}) {
  if(!['succeeded','failed','cancelled','timed_out','unknown'].includes(status))throw new Error('Invalid result status');
  if(!Number.isSafeInteger(startedMs)||!Number.isSafeInteger(endedMs)||startedMs<0||endedMs<startedMs||endedMs>253402300799999)throw new Error('Invalid event time range');
  if(!Number.isSafeInteger(attempt)||attempt<1)throw new Error('Invalid attempt');
  if(measurement(toolCalls)===null||measurement(toolFailures)===null||toolFailures>toolCalls)throw new Error('Invalid tool counts');
  const id=identifier(eventId??createUuidV7(startedMs),'event ID',true);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new Error('Invalid telemetry event UUID');
  return {schema_version:1,event_name:'agent.turn.completed',event_id:id,
    runtime:identifier(runtime,'runtime',true),run_id:identifier(runId,'run ID',true),task_id:identifier(taskId,'task ID'),
    agent_id:identifier(agentId,'agent ID'),model_id:identifier(modelId,'model ID'),provider:identifier(provider,'provider'),
    started_at:new Date(startedMs).toISOString(),ended_at:new Date(endedMs).toISOString(),duration_ms:endedMs-startedMs,
    status,attempt,tool_calls:toolCalls,tool_failures:toolFailures,usage:normalizeUsage(usage)};
}

export function openAgentEvent({runtime,sessionID,assistant,error,tools={},endedMs=Date.now()}) {
  if(assistant?.role!=='assistant')return null;
  const tokens=assistant.tokens??{},cache=tokens.cache??{};
  return turnEvent({runtime,runId:sessionID,agentId:assistant.agent,modelId:assistant.modelID,provider:assistant.providerID,
    startedMs:assistant.time?.created,endedMs:assistant.time?.completed??endedMs,status:(error||assistant.error)?'failed':'succeeded',
    toolCalls:tools.calls??0,toolFailures:tools.errors??0,
    usage:{input:tokens.input,output:tokens.output,total:tokens.total,reasoning:tokens.reasoning,cacheRead:cache.read,cacheWrite:cache.write,costUsd:assistant.cost}});
}

export function ompEvent({event,context,startedMs,endedMs=Date.now(),toolCalls=0,toolFailures=0}) {
  const message=event.message??{},usage=message.usage??{},model=context.model??{};
  return turnEvent({runtime:'omp',runId:context.sessionManager?.getSessionId?.(),modelId:message.model??model.id??model.name,
    provider:message.provider??model.provider,startedMs,endedMs,status:message.error?'failed':'succeeded',toolCalls,toolFailures,
    usage:{input:usage.input,output:usage.output,total:usage.totalTokens,reasoning:usage.reasoning,cacheRead:usage.cacheRead,
      cacheWrite:usage.cacheWrite,costUsd:usage.cost?.total}});
}

export function validateEvent(event) {
  if(!event || typeof event!=='object' || Array.isArray(event) ||
      schema.required.some(key=>!Object.hasOwn(event,key)||event[key]===undefined) || Object.keys(event).some(key=>!Object.hasOwn(schema.properties,key)))
    throw new Error('Invalid telemetry event fields');
  if(typeof event.event_id!=='string')throw new Error('Invalid telemetry event UUID');
  if(event.schema_version!==1 || event.event_name!=='agent.turn.completed')throw new Error('Unsupported telemetry event');
  const usageSchema=schema.properties.usage;
  if(!event.usage || typeof event.usage!=='object' || Array.isArray(event.usage) ||
      usageSchema.required.some(key=>!Object.hasOwn(event.usage,key)) || Object.keys(event.usage).some(key=>!Object.hasOwn(usageSchema.properties,key)))
    throw new Error('Invalid telemetry usage fields');
  for(const [key,value] of Object.entries(event.usage))
    if(value!==null && measurement(value,key!=='cost_usd')===null)throw new Error('Invalid telemetry measurement');
  const startedMs=Date.parse(event.started_at),endedMs=Date.parse(event.ended_at);
  if(typeof event.started_at!=='string'||typeof event.ended_at!=='string'||endedMs-startedMs!==event.duration_ms)throw new Error('Invalid telemetry duration');
  if(!Number.isFinite(startedMs)||!Number.isFinite(endedMs)||new Date(startedMs).toISOString()!==event.started_at||new Date(endedMs).toISOString()!==event.ended_at)throw new Error('Invalid telemetry timestamp');
  turnEvent({runtime:event.runtime,runId:event.run_id,taskId:event.task_id,agentId:event.agent_id,modelId:event.model_id,
    provider:event.provider,startedMs,endedMs,status:event.status,attempt:event.attempt,toolCalls:event.tool_calls,toolFailures:event.tool_failures,eventId:event.event_id});
  return event;
}
