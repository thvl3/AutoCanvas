import {CanvasApi} from '../canvas/api.js';
import {CanvasClient,type CanvasClientOptions} from '../canvas/client.js';
import type {Config} from '../config.js';
import type {CanvasDataProvider,ProviderHealth} from './types.js';
/** Explicit compatibility provider; never selected merely because a token exists. */
export class LegacyPatProvider extends CanvasApi implements CanvasDataProvider {
 constructor(protected readonly config:Config,options:CanvasClientOptions={}){super(new CanvasClient(config,options));}
 async healthCheck():Promise<ProviderHealth>{
  try{await this.authCheck();return {provider:'legacy-pat',state:'connected',origin:this.config.baseUrl};}
  catch{return {provider:'legacy-pat',state:'authentication_required',origin:this.config.baseUrl,message:'Legacy PAT authentication failed.'};}
 }
}
