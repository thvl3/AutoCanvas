import {CanvasApi} from '../canvas/api.js';
import {CanvasClient} from '../canvas/client.js';
import type {Config} from '../config.js';
import {demoFetch} from '../demo/fixtures.js';
import type {CanvasDataProvider,ProviderHealth} from './types.js';
/** Synthetic HTTP fixtures, no bearer header and no network. */
export class MockCanvasProvider extends CanvasApi implements CanvasDataProvider {
 constructor(private readonly config:Config){super(new CanvasClient(config,{fetch:demoFetch,auth:{authorization:()=>''}}));}
 async healthCheck():Promise<ProviderHealth>{return {provider:'mock',state:'connected',origin:this.config.baseUrl};}
}
