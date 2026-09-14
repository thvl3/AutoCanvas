import type {Entity,EntityKind} from '../domain/types.js';
export type CanvasSessionState='connected'|'canvas_not_open'|'authentication_required'|'extension_disconnected'|'bridge_disconnected'|'unknown';
export interface ProviderHealth {provider:string;state:CanvasSessionState;origin:string;message?:string;last_request_at?:string;}
/** Normalized acquisition boundary. Academic services never depend on browser/GraphQL/REST transport. */
export interface CanvasDataProvider {
 authCheck():Promise<{id:string;name?:string}>;
 courses():Promise<Entity[]>;
 course(courseId:string):Promise<Entity>;
 collection(kind:EntityKind,courseId:string):Promise<Entity[]>;
 assignment(courseId:string,id:string):Promise<Entity>;
 moduleItems(courseId:string,moduleId:string):Promise<Entity[]>;
 page(courseId:string,id:string):Promise<Entity>;
 file(courseId:string,id:string):Promise<Entity>;
 submission(courseId:string,assignmentId:string):Promise<Entity>;
 healthCheck():Promise<ProviderHealth>;
 download?(file:Entity,maxBytes:number):Promise<{bytes:Uint8Array;contentType?:string}>;
 schema?():Promise<unknown>;
}
