// Zero-price receipts stay separate from existing monetary holds. Never rewrite
// old balances, unknown paid calls or the monetary ledger's positive-hold schema.
import crypto from 'node:crypto';
import { beijingBudgetDate } from './conversation-budget.js';
const name = 'verified-free-model-calls-v1';
const fail = () => Object.assign(Error('免费调用记录无效或状态冲突'), { code:'PAID_LEDGER_UNAVAILABLE' });
export function createFreeCallAudit(storage, now) {
  function read() {
    const raw=storage.readText(name);let rows;
    try{rows=raw===null?[]:JSON.parse(raw);}catch{throw fail();}
    if(!Array.isArray(rows)||rows.length>100000||rows.some(r=>!r||typeof r.id!=='string'||r.amountCny!==0||
      !['reserved','dispatched','settled','released','unknown'].includes(r.state)||
      ![null,0].includes(r.actualCny)||!Number.isSafeInteger(r.createdAt)))throw fail();
    return {raw,rows};
  }
  function update(id,state) {
    const {raw,rows}=read(),r=rows.find(r=>r.id===id);
    const allowed={dispatched:['reserved'],settled:['dispatched'],released:['reserved'],unknown:['dispatched','unknown']};
    if(!r||!allowed[state]?.includes(r.state))throw fail();
    r.state=state;r.updatedAt=now();r.actualCny=state==='settled'?0:null;
    r.resolvedAt=['settled','released'].includes(state)?now():null;
    storage.writeText(name,JSON.stringify(rows),raw);return {...r};
  }
  return {
    records(filters={}) {return read().rows.filter(r=>(!filters.key||r.key===filters.key)&&(!filters.date||r.date===filters.date)).map(r=>({...r}));},
    reserve(key,operationId) {
      const {raw,rows}=read();if(rows.length>=100000||rows.some(r=>r.operationId===operationId))throw fail();
      const at=now(),row={id:crypto.randomBytes(16).toString('hex'),botId:'primary',key,date:beijingBudgetDate(at),operationId,
        state:'reserved',amountCny:0,actualCny:null,createdAt:at,updatedAt:at,expiresAt:at+1800000,resolvedAt:null,unknownReason:null};
      rows.push(row);storage.writeText(name,JSON.stringify(rows),raw);return row;
    },
    dispatch:id=>update(id,'dispatched'),complete:id=>update(id,'settled'),
    release:id=>update(id,'released'),unknown:id=>update(id,'unknown'),
  };
}
