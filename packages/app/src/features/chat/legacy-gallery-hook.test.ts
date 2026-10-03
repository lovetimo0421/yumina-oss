import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { clientDom } from '../../lib/feed-beacon.test-helpers';
import { useLegacyGallery } from '../../../sandbox/legacy-gallery';

test('gallery hook serializes drafts, preserves failures, and refreshes only clean data', async () => {
  const env = clientDom();
  let gallery!: ReturnType<typeof useLegacyGallery>;
  const writes: string[] = [];
  let staged = ''; 
  let settle!: () => void, reject!: (error: Error) => void, refreshes = 0;
  const call = async <T,>(method: string, args: unknown[]): Promise<T> => {
    if (method === 'legacyGallery.get') return {raw: '{"items":[]}', writable: true} as T;
    if (method === 'legacyGallery.stage') { staged = String(args[0]); return undefined as T; }
    if (method === 'legacyGallery.refresh') { refreshes++; return {one: 'fresh-url'} as T; }
    if (method === 'legacyGallery.set') {
      writes.push(String(args[0]));
      return new Promise<T>((resolve, fail) => { settle = () => resolve(undefined as T); reject = fail; });
    }
    return undefined as T;
  };
  function Host() {
    gallery = useLegacyGallery('s', false, {empty: () => ({items: []}), normalize: value => value as typeof gallery.data}, call);
    return null;
  }
  const root = createRoot(env.dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(Host)));
    assert.equal(gallery.ready, true);
    await act(async () => gallery.setData({items: [{id: 'one', url: 'draft-url'}]}));
    await act(async () => gallery.setData(old => ({...old, title: 'newer'})));
    await act(async () => env.dom.window.dispatchEvent(new env.dom.window.Event('focus')));
    assert.equal(refreshes, 0);
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(staged).title, 'newer', 'the latest draft is recoverable while the first write is pending');
    await act(async () => settle());
    assert.equal(writes.length, 2);
    assert.equal(JSON.parse(writes[1]!).title, 'newer');
    await act(async () => settle());
    await act(async () => env.dom.window.dispatchEvent(new env.dom.window.Event('focus')));
    assert.equal(gallery.data.items[0]!.url, 'fresh-url');
    await act(async () => gallery.setData(old => ({...old, title: 'unsaved'})));
    await act(async () => reject(new Error('conflict')));
    assert.equal(gallery.data.title, 'unsaved');
    assert.equal(gallery.writable, false);
    assert.equal(gallery.diagnosticReport, 'conflict');
    await act(async () => env.dom.window.dispatchEvent(new env.dom.window.Event('focus')));
    assert.equal(refreshes, 1);
    assert.equal(writes.length, 3);
  } finally { await act(async () => root.unmount()); env.restore(); }
});

test('read-only gallery cannot persist edits and late session loads are ignored', async () => {
  const env = clientDom();
  let gallery!: ReturnType<typeof useLegacyGallery>, finishOld!: () => void;
  let writes = 0;
  const call = async <T,>(method: string): Promise<T> => {
    if (method === 'legacyGallery.get') {
      if (!finishOld) return new Promise<T>(resolve => { finishOld = () => resolve({raw: '{"items":[],"old":true}', writable: true} as T); });
      return {raw: '{"items":[],"new":true}', writable: true} as T;
    }
    if (method === 'legacyGallery.set') writes++;
    return {} as T;
  };
  function Host({sid}: {sid: string}) {
    gallery = useLegacyGallery(sid, true, {empty: () => ({items: []}), normalize: value => value as typeof gallery.data}, call);
    return null;
  }
  const root = createRoot(env.dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(Host, {sid: 'old'})));
    await act(async () => root.render(createElement(Host, {sid: 'new'})));
    await act(async () => finishOld());
    assert.equal(gallery.data.new, true);
    await act(async () => gallery.setData({items: []}));
    assert.equal(writes, 0);
    assert.equal(gallery.writable, false);
  } finally { await act(async () => root.unmount()); env.restore(); }
});
