import {createHash} from 'node:crypto';
export function canonicalizeObservationValue(value) {
  if(value===null||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(canonicalizeObservationValue);
  return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonicalizeObservationValue(value[k])]));
}
export function observationFactsHash(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalizeObservationValue(value))).digest('hex')}`;
}
