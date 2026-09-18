import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const wrapperSource = readFileSync(
  new URL("../features/library/library-detail-panel.tsx", import.meta.url),
  "utf8",
);
const mobileSource = readFileSync(
  new URL("../features/library/library-detail-panel-mobile.tsx", import.meta.url),
  "utf8",
);
const desktopSource = readFileSync(
  new URL("../features/library/library-detail-panel-desktop.tsx", import.meta.url),
  "utf8",
);
const activitySource = readFileSync(
  new URL("../features/library/library-detail-activity-card.tsx", import.meta.url),
  "utf8",
);
const coverCropDialogSource = readFileSync(
  new URL("../features/editor/components/cover-crop-dialog.tsx", import.meta.url),
  "utf8",
);

test("the newer Library is selected only below the desktop breakpoint", () => {
  assert.match(wrapperSource, /useMediaQuery\("\(max-width: 767px\)"\)/);
  assert.match(
    wrapperSource,
    /isMobileDetail\s*\?\s*<LibraryDetailPanelMobile \{\.\.\.props\} \/>\s*:\s*<LibraryDetailPanelDesktop \{\.\.\.props\} \/>/,
  );
});

test("desktop Library keeps gallery composition, creator activity, and navigation restoration", () => {
  assert.match(desktopSource, /data-scroll-restoration-id="library-detail"/);
  assert.match(
    desktopSource,
    /openWorldPreview\(sharedWorldId, \{ tab: "playthroughs" \}\)/,
  );
  assert.match(
    desktopSource,
    /library-detail-hero[^"\n]*pb-\[10rem\][\s\S]*library-detail-hero-media[^"\n]*aspect-\[16\/5\][^"\n]*min-h-\[28rem\]/,
  );
  assert.doesNotMatch(desktopSource, /library-detail-hero[^"\n]*h-\[38rem\]/);
  assert.match(
    desktopSource,
    /<LibraryDetailActivityCard[\s\S]*layout="desktop"[\s\S]*showCreatorMetrics=\{canViewCreatorAnalytics\}[\s\S]*stats=\{activityStats\}/,
  );
  assert.match(desktopSource, /enabled: !isDraft && !isOrphanedFork/);
  assert.doesNotMatch(desktopSource, /library-detail-mobile-surface|max-h-\[32rem\]/);
  assert.match(desktopSource, /<WorldUpdateHistory\s+worldId=\{selectedItem\.id\}/);
});

test("Overview crop editor uses responsive percentage crops at the real gallery hero ratio", () => {
  assert.match(coverCropDialogSource, /from "react-image-crop"/);
  assert.match(coverCropDialogSource, /mode === "cover" \? 3 \/ 4 : 16 \/ 5/);
  assert.match(
    coverCropDialogSource,
    /<ReactCrop[\s\S]*crop=\{activePercentCrop\}[\s\S]*aspect=\{activeTargetAspect\}[\s\S]*keepSelection[\s\S]*ruleOfThirds[\s\S]*onChange=/,
  );
  assert.match(coverCropDialogSource, /unit: "%"/);
  assert.match(coverCropDialogSource, /fromPercentCrop\(percentCrop, safeSourceAspect, activeTargetAspect\)/);
  assert.doesNotMatch(coverCropDialogSource, /setPointerCapture|CROP_BOX_HANDLES/);
});

test("mobile Library keeps the requested gallery, identity, activity, and bounded history layout", () => {
  assert.match(mobileSource, /aspect-\[4\/3\][\s\S]*fetchPriority="high"/);
  assert.doesNotMatch(mobileSource, /crop=\{selectedItemCrop\.gallery\}/);
  assert.match(
    mobileSource,
    /<h1 id="library-detail-title"[\s\S]*<SupportBadge[\s\S]*<DropdownMenu>/,
  );
  assert.match(
    mobileSource,
    /<LibraryDetailActivityCard[\s\S]*layout="mobile"[\s\S]*showCreatorMetrics=\{canViewCreatorAnalytics\}[\s\S]*stats=\{activityStats\}/,
  );
  assert.match(activitySource, /<dl className="grid grid-cols-3 pt-3">/);
  assert.doesNotMatch(activitySource, /<dl className="[^"]*(?:rounded|border|bg-)/);
  assert.match(mobileSource, /<WorldUpdateHistory\s+worldId=\{selectedItem\.id\}/);
  assert.match(mobileSource, /max-h-\[32rem\][^"]*overflow-y-auto/);
  const historySource = readFileSync(
    new URL("../features/library/world-update-history.tsx", import.meta.url),
    "utf8",
  );
  assert.match(historySource, /max-h-80[^"]*overflow-y-auto/);
  assert.doesNotMatch(mobileSource, /t\("detail\.published"\)/);
});
