/** Development-only harness: real crop dialogs and styles, no account or API. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./preview.css";
import "@/lib/i18n";
import { CoverCropDialog as StandardDialog } from "@/features/editor/components/cover-crop-dialog";
import { CoverCropDialog as PreviewDialog } from "@/features/editor/components/cover-crop-dialog-preview";
import type { CoverCropSettings } from "@/lib/cover-crop";

const params = new URLSearchParams(location.search);
const aspect = Number(params.get("aspect") ?? 0.6);
const width = 600;
const height = width / aspect;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#f77"/><stop offset="1" stop-color="#37a"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><path d="M0 0H${width}V${height}H0Z" fill="none" stroke="#fff" stroke-width="16"/><path d="M0 ${height / 2}H${width}M${width / 2} 0V${height}" stroke="#fff" stroke-width="4"/><text x="30" y="70" font-size="42">TOP</text><text x="30" y="${height - 30}" font-size="42">BOTTOM</text></svg>`;
const src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
const Dialog = params.get("dialog") === "standard" ? StandardDialog : PreviewDialog;
function Harness() {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState<{ coverCrop?: CoverCropSettings; landscapeCoverCrop?: CoverCropSettings }>({});
  return <><button onClick={() => setOpen(true)}>Reopen crop</button><pre id="saved-crop">{JSON.stringify(saved)}</pre>{open && <Dialog src={src} landscapeSrc={src} initialMode="gallery" initialCoverCrop={saved.coverCrop} initialLandscapeCrop={saved.landscapeCoverCrop} onCancel={() => setOpen(false)} onSave={value => { setSaved(value); setOpen(false); }} />}</>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
