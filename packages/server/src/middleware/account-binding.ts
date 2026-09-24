import {createMiddleware} from 'hono/factory';
import type {AppEnv} from '../lib/types.js';

/** Optional first-party binding: a delayed settings write belongs to the login
 * that opened its controls. Authentication still supplies the actual owner. */
export const optionalAccountBinding=createMiddleware<AppEnv>(async(c,next)=>{
 const expected=c.req.header('X-Yumina-Account-Id');
 if(expected!==undefined&&expected!==c.get('user').id)return c.json({error:'account_changed'},409);
 await next();
});
