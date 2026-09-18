import {
  BookOpen,
  Code,
  Cog,
  FolderOpen,
  LayoutGrid,
  MessageCircle,
  MessageSquare,
  Music,
  Package,
  PanelRight,
  Variable,
  Zap as ZapIcon,
  type LucideIcon,
} from "lucide-react";
import type { DockviewApi } from "dockview-react";

export const STUDIO_ADD_PAGE_PICKER_COMPONENT = "studio-add-page-picker";

export type StudioAddPagePickerParams = {
  openerGroupId: string;
};

export type StudioPanelMenuItem = {
  id: string;
  labelKey: string;
  icon: LucideIcon;
};

export const PANEL_MENU_GROUPS = [
  {
    labelKey: "studio.groups.story",
    items: [
      { id: "first-message", labelKey: "studio.panels.firstMessage", icon: MessageCircle },
      { id: "lorebook", labelKey: "studio.panels.lorebook", icon: BookOpen },
      { id: "variables", labelKey: "studio.panels.variables", icon: Variable },
      { id: "rules", labelKey: "studio.panels.behaviors", icon: ZapIcon },
    ],
  },
  {
    labelKey: "studio.groups.display",
    items: [
      { id: "code-view", labelKey: "studio.panels.frontEndCode", icon: Code },
      { id: "audio", labelKey: "studio.panels.audio", icon: Music },
      { id: "assets", labelKey: "studio.panels.assets", icon: FolderOpen },
    ],
  },
  {
    labelKey: "studio.groups.others",
    items: [
      { id: "overview", labelKey: "studio.panels.overview", icon: Cog },
      { id: "sidebar", labelKey: "studio.panels.previewControls", icon: PanelRight },
      { id: "canvas", labelKey: "studio.panels.canvas", icon: LayoutGrid },
      { id: "ai-chat", labelKey: "studio.panels.aiAssistant", icon: MessageSquare },
      { id: "marketplace", labelKey: "studio.panels.marketplace", icon: Package },
    ],
  },
] as const satisfies ReadonlyArray<{
  labelKey: string;
  items: ReadonlyArray<StudioPanelMenuItem>;
}>;

export function getAddPagePickerPanelId(groupId: string) {
  return `${STUDIO_ADD_PAGE_PICKER_COMPONENT}::${groupId}`;
}

function createPanelInstanceId(panelId: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${panelId}::${crypto.randomUUID()}`;
  }

  return `${panelId}::${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getActiveStudioGroup(containerApi: DockviewApi) {
  return containerApi.activeGroup ?? containerApi.activePanel?.group ?? containerApi.groups[0];
}

export function openAddPagePicker(options: {
  containerApi: DockviewApi;
  groupId: string;
  title: string;
}) {
  const targetGroupId = options.containerApi.getGroup(options.groupId)
    ? options.groupId
    : getActiveStudioGroup(options.containerApi)?.id;

  const pickerId = getAddPagePickerPanelId(targetGroupId ?? options.groupId);
  const existingPicker = options.containerApi.getPanel(pickerId);

  if (existingPicker && existingPicker.group.id === targetGroupId) {
    existingPicker.api.setTitle(options.title);
    existingPicker.api.setActive();
    return existingPicker;
  }

  if (targetGroupId) {
    return options.containerApi.addPanel<StudioAddPagePickerParams>({
      id: pickerId,
      component: STUDIO_ADD_PAGE_PICKER_COMPONENT,
      title: options.title,
      params: { openerGroupId: targetGroupId },
      position: { referenceGroup: targetGroupId, direction: "within" },
    });
  }

  return options.containerApi.addPanel<StudioAddPagePickerParams>({
    id: pickerId,
    component: STUDIO_ADD_PAGE_PICKER_COMPONENT,
    title: options.title,
    params: { openerGroupId: options.groupId },
  });
}

export function addStudioPanelInstance(options: {
  containerApi: DockviewApi;
  panelId: string;
  title: string;
  referenceGroupId: string;
  referencePanelId?: string;
}) {
  const instanceId = createPanelInstanceId(options.panelId);
  const referencePanel = options.referencePanelId
    ? options.containerApi.getPanel(options.referencePanelId)
    : undefined;

  if (referencePanel) {
    return options.containerApi.addPanel({
      id: instanceId,
      component: options.panelId,
      title: options.title,
      position: { referencePanel, direction: "within" },
    });
  }

  if (options.containerApi.getGroup(options.referenceGroupId)) {
    return options.containerApi.addPanel({
      id: instanceId,
      component: options.panelId,
      title: options.title,
      position: { referenceGroup: options.referenceGroupId, direction: "within" },
    });
  }

  return options.containerApi.addPanel({
    id: instanceId,
    component: options.panelId,
    title: options.title,
  });
}
