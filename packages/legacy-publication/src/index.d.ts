import type {Pool} from 'pg';
export type LegacyValue=Record<string,any>;
export function observationFactsHash(value:unknown):string;
export function publicationResultHash(domain:string,value:unknown):string;
export function buildPublicationShard(items:LegacyValue[],options?:{shardId?:string;createdAt?:string}):LegacyValue;
export function normalizePublicationShard(value:unknown):LegacyValue;
export function normalizePublicationEnvelope(value:unknown):LegacyValue;
export function validateBusinessPublicationEnvelope(value:LegacyValue):LegacyValue;
export class PostgresBusinessPublicationStore {constructor(pool:Pool);acceptShard(value:LegacyValue):Promise<LegacyValue>;}
export class PostgresBusinessPublicationActivator {constructor(pool:Pool);activateReady(channelId:string):Promise<LegacyValue>;}
export class PostgresBusinessPublicationProjector {constructor(pool:Pool,options?:{batchSize?:number});runOnce():Promise<LegacyValue>;}
