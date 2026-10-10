import type { QueryResultRow } from 'pg';
import type { FrozenInput } from '@crawlsystem/contracts';
export function expectedPipelineSteps(row: QueryResultRow, targets: string[] | null): Map<string,string[]> {
  const frozen=row.frozen_input as FrozenInput,steps=new Map<string,string[]>();
  if (frozen.required_domains.includes('ABOUT')) steps.set('ABOUT',['channel']);
  if (frozen.required_domains.includes('VIDEO')) {
    if (frozen.source_mode==='youtube') steps.set('TARGETS',['uploads']);
    if (targets) for(let i=0;i<Math.ceil(targets.length/10);i++) steps.set(`VIDEO-${i}`,targets.slice(i*10,(i+1)*10));
    const sampling=frozen.source_mode==='youtube' ? frozen.recent_sampling?.video_ids??[] : [];
    if(sampling.length) steps.set('SAMPLING',sampling);
  }
  if(frozen.required_domains.includes('AGENT')) steps.set('AGENT',['profile']);
  return steps;
}
