import { createContext, useContext } from "react";
import { YuminaContext, type SandboxedYuminaAPI } from "../sandbox-context";

/** The model controls are also used by first-party native games. Keep their
 * adapter small; a game should not have to impersonate an entire world session. */
export type ModelControlsAPI = Pick<SandboxedYuminaAPI,
  "selectedModel" | "userPlan" | "preferredProvider" | "language" | "balance" |
  "messages" | "mixMode" | "modelPool" | "setPreferredProvider" | "setModel" |
  "getModels" | "pinModel" | "unpinModel" | "setMixMode" | "addToPool" |
  "removeFromPool" | "setPoolWeight" | "togglePoolLock">;

export const ModelControlsContext = createContext<ModelControlsAPI | null>(null);
export function useModelControls(): ModelControlsAPI {
  const override = useContext(ModelControlsContext);
  const world = useContext(YuminaContext);
  return override ?? world;
}
