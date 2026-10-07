import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Variable } from '@yumina/engine';
import { parseVariableValue } from './variable-value';

export function VariableValueField({ variable, onCommit, compact }: { variable: Variable; onCommit: (value: Variable['defaultValue']) => void;
  /** The blueprint column's rhythm: label on the left, control on the right,
   *  a switch for a boolean. Json still takes the full width. */
  compact?: boolean }) {
  const { t } = useTranslation('editor');
  const id = useId();
  const shown = typeof variable.defaultValue === 'string' ? variable.defaultValue : JSON.stringify(variable.defaultValue, null, 2);
  const [raw, setRaw] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setRaw(shown); setError(null); }, [variable.id, variable.type, shown]);
  const commit = () => {
    const parsed = parseVariableValue(variable.type, raw);
    if (!parsed.ok) { setError(t(`blueprint.workspace.invalid.${parsed.error}`)); return; }
    setError(null);
    if (JSON.stringify(parsed.value) !== JSON.stringify(variable.defaultValue)) onCommit(parsed.value);
  };
  const props = {
    id, value: raw, 'aria-invalid': !!error, 'aria-describedby': error ? `${id}-error` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setRaw(e.target.value); setError(null); },
    onBlur: commit,
    className: 'studio-control w-full rounded-lg border px-3 py-2 text-sm text-foreground focus:studio-control-focus focus:outline-none aria-[invalid=true]:border-rose-400',
  };
  if (compact && variable.type !== 'json') {
    const control = variable.type === 'boolean'
      ? <button type="button" role="switch" aria-checked={variable.defaultValue === true} aria-label={t('blueprint.insp.startsAt')} onClick={() => onCommit(variable.defaultValue !== true)}
          className={`relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors ${variable.defaultValue === true ? 'bg-[rgba(240,198,116,0.22)] shadow-[0_0_12px_rgba(240,198,116,0.35)]' : 'bg-white/10'}`}>
          <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full transition-[left] ${variable.defaultValue === true ? 'left-[14px] bg-[#f5d48a]' : 'left-[2px] bg-foreground/60'}`} />
        </button>
      : <input {...props} inputMode={variable.type === 'number' ? 'decimal' : 'text'} onKeyDown={e => { if (e.key === 'Enter') commit(); }}
          className="studio-control h-[26px] w-[120px] rounded-lg border px-2 text-xs text-foreground tabular-nums focus:outline-none aria-[invalid=true]:border-rose-400" />;
    return <div className="space-y-1">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <label htmlFor={id} className="text-xs text-foreground/66">{t('blueprint.insp.startsAt')}</label>
        <div className="flex w-[176px] shrink-0 items-center justify-end gap-2">{variable.type === 'boolean' && <span className="text-xs text-foreground/66">{t(variable.defaultValue === true ? 'blueprint.workspace.true' : 'blueprint.workspace.false')}</span>}{control}</div>
      </div>
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-rose-300">{error}</p>}
    </div>;
  }
  return <div className="space-y-2">
    <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{t('blueprint.insp.startsAt')}</label>
    {variable.type === 'boolean' ? <label className="flex items-center gap-3 rounded-lg border border-white/[0.06] px-3 py-2">
      <input id={id} type="checkbox" checked={variable.defaultValue === true} onChange={e => onCommit(e.target.checked)} className="h-4 w-4 accent-amber-400" />
      <span className="text-sm">{t(variable.defaultValue === true ? 'blueprint.workspace.true' : 'blueprint.workspace.false')}</span>
    </label> : variable.type === 'json' ? <textarea {...props} rows={6} spellCheck={false} /> : <input {...props} inputMode={variable.type === 'number' ? 'decimal' : 'text'} onKeyDown={e => { if (e.key === 'Enter') commit(); }} />}
    {error && <p id={`${id}-error`} role="alert" className="text-xs text-rose-300">{error}</p>}
  </div>;
}
