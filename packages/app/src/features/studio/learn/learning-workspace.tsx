import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { LearningStage, LearningStepId } from "./learning-catalog";

type LearningWorkspace = {
  step: LearningStepId | null;
  setStep: (step: LearningStepId | null) => void;
  /** A 基础 lesson's canvas: only these block kinds are drawn. Null draws
   *  the whole board. */
  stage: LearningStage | null;
  /** The block kinds the camera frames, with room kept beside them for the
   *  guide; null frames the whole stage. */
  focus: LearningStage | null;
  setStage: (stage: LearningStage | null, focus?: LearningStage | null) => void;
  inspecting: boolean;
  setInspecting: (inspecting: boolean) => void;
  /** Mushie has the screen: the welcome dialog, a lesson, or the wrap-up.
   *  Anything else that wants to speak up on a first visit waits its turn
   *  — two first-time notices at once teach neither. */
  teaching: boolean;
  setTeaching: (teaching: boolean) => void;
};
const LearningWorkspaceContext = createContext<LearningWorkspace>({ step: null, setStep: () => {}, stage: null, focus: null, setStage: () => {}, inspecting: false, setInspecting: () => {}, teaching: false, setTeaching: () => {} });

export function LearningWorkspaceProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<LearningStepId | null>(null);
  const [staged, setStaged] = useState<{ stage: LearningStage | null; focus: LearningStage | null }>({ stage: null, focus: null });
  const setStage = useCallback((stage: LearningStage | null, focus: LearningStage | null = null) => setStaged({ stage, focus: stage ? focus : null }), []);
  const [inspecting, setInspecting] = useState(false);
  const [teaching, setTeaching] = useState(false);
  const value = useMemo(() => ({ step, setStep, stage: staged.stage, focus: staged.focus, setStage, inspecting, setInspecting, teaching, setTeaching }), [step, staged, setStage, inspecting, teaching]);
  return <LearningWorkspaceContext.Provider value={value}>{children}</LearningWorkspaceContext.Provider>;
}
export const useLearningWorkspace = () => useContext(LearningWorkspaceContext);
