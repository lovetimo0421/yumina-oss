import type { IDockviewHeaderActionsProps } from "dockview-react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openAddPagePicker } from "./studio-page-catalog";

export function StudioGroupAddButton({ containerApi, group }: IDockviewHeaderActionsProps) {
  const { t } = useTranslation("editor");

  return (
    <button
      type="button"
      className="studio-tab-add-button"
      title={t("studio.addPanel")}
      aria-label={t("studio.addPanel")}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openAddPagePicker({
          containerApi,
          groupId: group.id,
          title: t("studio.addPanel"),
        });
      }}
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}
