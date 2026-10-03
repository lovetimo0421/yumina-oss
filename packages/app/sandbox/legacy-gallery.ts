import { useEffect, useRef, useState } from 'react';

type Data = Record<string, unknown> & { items: { id: string; url: string }[] };
export type LegacyGalleryOptions = { empty: () => Data; normalize: (value: unknown) => Data };
type Call = <T>(method: string, args: unknown[], timeout?: number) => Promise<T>;

/** Keep the published hook's return contract, but persist through owned media.
 * A failed write retains the draft and locks further writes until reload. Never
 * adopt unseen versions and retry a conflicting edit over another device.
 */
export function useLegacyGallery(sid: string, readOnly: boolean, options: LegacyGalleryOptions, call: Call) {
  const [data, install] = useState(options.empty);
  const [ready, setReady] = useState(false);
  const [writable, setWritable] = useState(false);
  const [diagnosticReport, setDiagnostic] = useState('');
  const state = useRef({ data, revision: 0, saved: 0, writing: false, active: false, writable: false });
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const current = { data: optionsRef.current.empty(), revision: 0, saved: 0, writing: false, active: true, writable: false };
    state.current = current;
    install(current.data); setReady(false); setWritable(false); setDiagnostic('');
    function failed(error: unknown) {
      if (!current.active) return;
      current.writable = false; setWritable(false);
      setDiagnostic(error instanceof Error ? error.message : 'Gallery persistence failed.');
      void call('showToast', ['Gallery persistence failed.', 'error']).catch(() => {});
    }
    if (sid) void call<{ raw: string; writable: boolean }>('legacyGallery.get', [], 600_000).then(result => {
      if (!current.active) return;
      current.data = optionsRef.current.normalize(JSON.parse(result.raw));
      current.writable = !readOnly && result.writable;
      install(current.data); setWritable(current.writable); setReady(true);
    }).catch(error => { failed(error); if (current.active) setReady(true); });
    else setReady(true);
    const refresh = () => {
      if (!current.active || current.writing || current.revision !== current.saved || !sid) return;
      const revision = current.revision;
      void call<Record<string, string>>('legacyGallery.refresh', [], 60_000).then(urls => {
        if (!current.active || current.writing || current.revision !== revision) return;
        current.data = { ...current.data, items: current.data.items.map(item => urls[item.id] ? { ...item, url: urls[item.id]! } : item) };
        install(current.data);
      }).catch(() => { /* Keep the displayed draft; retry URL refresh on focus. */ });
    };
    const timer = setInterval(refresh, 240_000);
    window.addEventListener('focus', refresh);
    return () => { current.active = false; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [sid, readOnly, call]);

  const setData = (next: Data | ((old: Data) => Data)) => {
    const current = state.current;
    if (!current.active || !current.writable) return;
    current.data = optionsRef.current.normalize(typeof next === 'function' ? next(current.data) : next);
    current.revision++;
    install(current.data);
    // Stage every revision, including edits made while an earlier upload waits.
    // Browser quota failure must not prevent a successful cloud save.
    const staged = JSON.stringify(current.data, (key, value) => key === '_assetIntegrityUrl' ? undefined : value);
    void call('legacyGallery.stage', [staged]).catch(() => {});
    if (current.writing) return;
    current.writing = true;
    void (async () => {
      try {
        while (current.active && current.saved !== current.revision) {
          const revision = current.revision;
          const raw = JSON.stringify(current.data, (key, value) => key === '_assetIntegrityUrl' ? undefined : value);
          await call('legacyGallery.set', [raw], 600_000);
          current.saved = revision;
        }
      } catch (error) {
        if (current.active) {
          current.writable = false; setWritable(false);
          setDiagnostic(error instanceof Error ? error.message : 'Gallery persistence failed.');
          void call('showToast', ['Gallery persistence failed.', 'error']).catch(() => {});
        }
      } finally { current.writing = false; }
    })();
  };
  return { data, setData, ready, writable, storageMode: ready ? (writable ? 'cloud' : 'readonly') : 'loading', diagnosticReport, clearDiagnostic: () => setDiagnostic('') };
}
