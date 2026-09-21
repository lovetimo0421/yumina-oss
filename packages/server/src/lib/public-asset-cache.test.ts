import test from 'node:test';
import assert from 'node:assert/strict';
import {publicAssetCacheControl} from './public-asset-cache.js';
test('only immutable packaged game resources receive long-lived caching',()=>{
 const prefix='worlds/pvz-previews/'+'a'.repeat(64)+'/';
 for(const name of ['main.pak','properties/default.xml','properties/Layout.xml','properties/partner.xml','properties/partner.xml.sig','properties/partner_logo.jpg'])
  assert.equal(publicAssetCacheControl(prefix+name),'public, max-age=31536000, immutable');
 for(const key of ['users/a/avatar.png','worlds/a/image.jpg',prefix+'index.html',prefix+'unexpected.txt',prefix+'../main.pak','worlds/pvz-previews/latest/main.pak'])
  assert.equal(publicAssetCacheControl(key),'public, max-age=0, s-maxage=300, must-revalidate');
});
