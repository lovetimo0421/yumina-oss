import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  getHistoryEntrySessionStorage,
  readHistoryEntryState,
  resolveHistoryEntryStateTransition,
  writeHistoryEntryState,
} from "@/lib/history-entry-state";

interface EntryState<T> {
  entryKey: string | undefined;
  entryIndex: number | undefined;
  value: T;
}

/**
 * React-local view state normally disappears when a route unmounts. Keep the
 * requested value with the unique TanStack history entry so Back/Forward can
 * reconstruct that exact tab, filter, query, or page without putting private
 * UI state in a return URL.
 */
export function useHistoryEntryState<T>(
  scope: string,
  fallback: T,
  validate: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const entryKey = useRouterState({
    select: (state) => state.location.state.__TSR_key,
  });
  const entryIndex = useRouterState({
    select: (state) => state.location.state.__TSR_index,
  });
  const storage = getHistoryEntrySessionStorage();
  const [state, setState] = useState<EntryState<T>>(() => ({
    entryKey,
    entryIndex,
    value: readHistoryEntryState(storage, entryKey, scope, fallback, validate).value,
  }));

  const renderedValue = state.entryKey === entryKey
    ? state.value
    : resolveHistoryEntryStateTransition(
        storage,
        { key: entryKey, index: entryIndex },
        { index: state.entryIndex, value: state.value },
        scope,
        fallback,
        validate,
      );

  if (state.entryKey !== entryKey) {
    setState({ entryKey, entryIndex, value: renderedValue });
  }

  useEffect(() => {
    writeHistoryEntryState(storage, state.entryKey, scope, state.value);
  }, [scope, state, storage]);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    setState((current) => {
      const previous = current.entryKey === entryKey
        ? current.value
        : resolveHistoryEntryStateTransition(
            storage,
            { key: entryKey, index: entryIndex },
            { index: current.entryIndex, value: current.value },
            scope,
            fallback,
            validate,
          );
      const next = typeof update === "function"
        ? (update as (value: T) => T)(previous)
        : update;
      return { entryKey, entryIndex, value: next };
    });
  }, [entryIndex, entryKey, fallback, scope, storage, validate]);

  return [renderedValue, setValue];
}
