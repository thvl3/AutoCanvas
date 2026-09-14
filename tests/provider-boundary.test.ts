import {it,expect} from 'vitest';
import {MockCanvasProvider} from '../src/providers/mock.js';
import {LegacyPatProvider} from '../src/providers/legacy-pat.js';
import {loadConfig} from '../src/config.js';
it('adapts the existing API to the normalized provider without academic changes',async()=>{
 const config=loadConfig({CANVAS_BASE_URL:'https://canvas.example.invalid',CANVAS_ACCESS_TOKEN:'fixture'});
 const provider=new MockCanvasProvider(config);
 expect((await provider.authCheck()).id).toBe('7');
 expect((await provider.courses()).map(c=>c.kind)).toEqual(['courses','courses','courses']);
 expect(await provider.healthCheck()).toMatchObject({provider:'mock',state:'connected'});
 expect(LegacyPatProvider.prototype).toHaveProperty('healthCheck');
});
