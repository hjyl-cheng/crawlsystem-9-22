import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
export {kube,object,workspace,client} from './finish-common.ts';
export const dir='.runtime/channel-filters';
mkdirSync(dir,{recursive:true,mode:0o700});
export const save=(name:string,value:unknown,exclusive=false)=>writeFileSync(`${dir}/${name}.json`,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:exclusive?'wx':'w'});
export const load=(name:string)=>JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8'));
