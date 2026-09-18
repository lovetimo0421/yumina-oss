import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { importWithChunkRecovery } from "@/lib/stale-chunk-reload";

export function lazyRouteComponent<TModule, TProps = object>(
  loader: () => Promise<TModule>,
  select: (module: TModule) => ComponentType<TProps>
): LazyExoticComponent<ComponentType<TProps>> {
  return lazy(() =>
    importWithChunkRecovery(loader).then((module) => ({
      default: select(module),
    }))
  );
}
