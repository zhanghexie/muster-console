import {redactCredentialShapes} from '../redact';

export interface CuratorResponseMetadata {status?:number;retryAt?:number}
interface RetryMetadata extends CuratorResponseMetadata {kind?:'network'|'timeout'}
/** Created only from host transport callbacks, never by parsing model/response body text. */
export class CuratorRequestError extends Error {
  readonly status?:number;
  readonly retryAt?:number;
  readonly kind?:'network'|'timeout';
  constructor(message:string,metadata:RetryMetadata={}){
    super(redactCredentialShapes(message).text);this.name='CuratorRequestError';
    this.status=Number.isInteger(metadata.status)&&metadata.status!>=100&&metadata.status!<=599?metadata.status:undefined;
    this.retryAt=Number.isFinite(metadata.retryAt)&&metadata.retryAt!>=0&&metadata.retryAt!<=8.64e15?metadata.retryAt:undefined;
    this.kind=metadata.kind;
  }
}
function future(value:number|undefined,now:number):number|undefined{return value!=null&&Number.isFinite(value)&&value>now&&value<=8.64e15?value:undefined;}
function absolute(value:unknown,now:number):number|undefined {
  if(typeof value==='number'||typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value.trim())){
    const number=Number(value);return future(number>=1e12?number:number*1000,now);
  }
  return typeof value==='string'?future(Date.parse(value),now):undefined;
}
function duration(value:string):number|undefined {
  const text=value.trim().toLowerCase();if(!text)return undefined;
  let total=0,last=0;
  for(const item of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g)){
    if(text.slice(last,item.index).trim())return undefined;
    total+=Number(item[1])*({ms:1,s:1000,m:60000,h:3600000,d:86400000}[item[2]]??0);last=item.index!+item[0].length;
  }
  return last&&text.slice(last).trim()===''&&Number.isFinite(total)?total:undefined;
}
export function parseCuratorResponse(response:{status?:unknown;headers?:Record<string,string>;resetAt?:unknown},now=Date.now()):CuratorResponseMetadata {
  const status=typeof response.status==='number'&&Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:undefined;
  const headers=new Map(Object.entries(response.headers??{}).map(([key,value])=>[key.toLowerCase(),value]));
  const times:number[]=[];
  const add=(value:number|undefined)=>{if(value!==undefined)times.push(value);};
  const after=headers.get('retry-after');
  if(after!=null)add(/^\d+(?:\.\d+)?$/.test(after.trim())?future(now+Number(after)*1000,now):future(Date.parse(after),now));
  add(absolute(response.resetAt,now));
  for(const name of ['resetat','reset-at','x-reset-at','x-ratelimit-reset-at','x-quota-reset-at'])add(absolute(headers.get(name),now));
  for(const name of ['ratelimit-reset','x-ratelimit-reset','x-rate-limit-reset','x-ratelimit-reset-requests','x-ratelimit-reset-tokens']){
    const value=headers.get(name);if(value==null)continue;
    const delta=duration(value);
    if(delta!==undefined)add(future(now+delta,now));
    else if(/^\d+(?:\.\d+)?$/.test(value.trim())){const number=Number(value);add(number>=1e9?absolute(number,now):future(now+number*1000,now));}
    else add(absolute(value,now));
  }
  return {status,retryAt:times.length?Math.max(...times):undefined};
}
function transportKind(error:unknown):'network'|'timeout'|undefined {
  const value=error as {code?:unknown;name?:unknown;message?:unknown}|null;
  const code=typeof value?.code==='string'?value.code:'';
  const message=error instanceof Error?error.message:typeof value?.message==='string'?value.message:'';
  if(/^(?:ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(code)||/\btimeout\b|timed out|连接超时|请求超时/i.test(message))return 'timeout';
  if(/^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET)$/.test(code)||/fetch failed|network (?:error|failure)|socket hang up|网络连接失败/i.test(message))return 'network';
  return undefined;
}
export function curatorRequestError(error:unknown,response?:CuratorResponseMetadata):CuratorRequestError {
  if(error instanceof CuratorRequestError)return error;
  const message=error instanceof Error?error.message:String(error);
  return new CuratorRequestError(message,{...response,kind:response?.status==null?transportKind(error):undefined});
}
export interface CuratorRetryDecision extends CuratorResponseMetadata {retry:boolean}
export function curatorRetryDecision(error:unknown,attempt:number,now=Date.now()):CuratorRetryDecision {
  const trusted=error instanceof CuratorRequestError?error:undefined,status=trusted?.status;
  const retry=status!=null?status===408||status===429||status>=500&&status<=599:!!(trusted?.kind??transportKind(error));
  if(!retry)return {retry:false,status};
  const supplied=future(trusted?.retryAt,now);
  const delay=Math.min(status===429?900_000:60_000,(status===429?30_000:1000)*2**Math.max(0,Math.min(attempt-1,10)));
  return {retry:attempt<3,status,retryAt:supplied??now+delay};
}
