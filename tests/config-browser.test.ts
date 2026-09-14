import {it,expect} from 'vitest';
import {loadConfig} from '../src/config.js';
it('defaults to browser session without any Canvas token and ignores obsolete tokens',()=>{
 const config=loadConfig({CANVAS_BASE_URL:'https://byui.instructure.com'});
 expect(config).toMatchObject({provider:'browser',accessToken:'',bridgeHost:'127.0.0.1',bridgePort:47821});
 expect(loadConfig({CANVAS_BASE_URL:'https://byui.instructure.com',CANVAS_ACCESS_TOKEN:'obsolete-token'}).accessToken).toBe('');
});
it('requires a token only for explicitly selected legacy compatibility',()=>{
 expect(()=>loadConfig({CANVAS_BASE_URL:'https://byui.instructure.com',CANVAS_PROVIDER:'legacy-pat'})).toThrow(/CANVAS_ACCESS_TOKEN/);
 expect(loadConfig({CANVAS_BASE_URL:'https://byui.instructure.com',CANVAS_PROVIDER:'legacy-pat',CANVAS_ACCESS_TOKEN:'fixture'}).accessToken).toBe('fixture');
});
it('fails closed on nonloopback bridge configuration and invalid ports/provider',()=>{
 for(const change of [{CANVAS_BRIDGE_HOST:'0.0.0.0'},{CANVAS_BRIDGE_HOST:'localhost'},{CANVAS_BRIDGE_PORT:'0'},{CANVAS_BRIDGE_PORT:'65536'},{CANVAS_PROVIDER:'auto'}])expect(()=>loadConfig({CANVAS_BASE_URL:'https://byui.instructure.com',...change})).toThrow(/configuration/i);
});
