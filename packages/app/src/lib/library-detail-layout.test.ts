import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  formatAverageRating,
  formatAverageSession,
  formatStatCount,
} from "./library-detail-stats.js";

const source = readFileSync(
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
const statsSource = readFileSync(new URL("./library-detail-stats.ts", import.meta.url), "utf8");
const updateHistorySource = readFileSync(
  new URL("../features/library/world-update-history.tsx", import.meta.url),
  "utf8",
);
const updateHistoryDataSource = readFileSync(
  new URL("../features/library/world-update-history-data.ts", import.meta.url),
  "utf8",
);
const updateNotifySource = readFileSync(
  new URL("../features/editor/update-notify-dialog.tsx", import.meta.url),
  "utf8",
);
const updateNoteSource = readFileSync(
  new URL("../features/editor/world-update-note.ts", import.meta.url),
  "utf8",
);
const quickCreateSource = readFileSync(
  new URL("../features/editor/quick-create-editor.tsx", import.meta.url),
  "utf8",
);
const worldsStoreSource = readFileSync(new URL("../stores/worlds.ts", import.meta.url), "utf8");
const libraryGridSource = readFileSync(
  new URL("../features/library/library-game-grid.tsx", import.meta.url),
  "utf8",
);
const activityLocaleKeys = [
  "activity",
  "downloads",
  "chatVolume",
  "favoriteCount",
  "uniquePlayers",
  "averageSession",
  "averageRating",
] as const;
const updateHistoryLocaleKeys = [
  "updateHistory",
  "updateHistoryLoading",
  "updateHistoryLoadError",
  "noUpdateHistory",
  "updateHistoryListLabel",
  "updatedBy",
  "majorUpdate",
  "reviewsScrollableLabel",
  "updateHistoryRetry",
  "updateHistoryLoadMoreError",
  "loadOlderUpdates",
  "loadingOlderUpdates",
] as const;

test("mobile library details bridge the gallery into one surfaced identity and metadata card", () => {
  assert.match(
    source,
    /library-detail-content-shell[^\n]*-mt-3/,
    "the identity bar should only slightly overlap the gallery edge",
  );
  assert.match(
    source,
    /<section aria-labelledby="library-detail-title" className="library-detail-mobile-surface rounded-2xl">\s*<div className="px-3 py-3">/,
    "the title and creator row should start the shared transition surface",
  );

  const surfaceStart = source.indexOf('aria-labelledby="library-detail-title" className="library-detail-mobile-surface rounded-2xl"');
  const surfaceEnd = source.indexOf("\n        </section>", surfaceStart);
  const compactSurface = source.slice(surfaceStart, surfaceEnd);

  assert.ok(surfaceStart >= 0 && surfaceEnd > surfaceStart);
  assert.match(
    compactSurface,
    /<h1 id="library-detail-title"[\s\S]*<div className="flex shrink-0 items-center gap-2">[\s\S]*<SupportBadge[\s\S]*<DropdownMenu>/,
    "support and the overflow menu should share the title row",
  );
  assert.match(
    compactSurface,
    /<h1 id="library-detail-title" className="min-w-0 flex-1 break-words/,
    "long titles should shrink and wrap beside the fixed-width action group",
  );
  assert.equal(
    compactSurface.match(/<SupportBadge/g)?.length,
    1,
    "support should render once in the title-row action group",
  );
  assert.match(
    compactSurface,
    /<SupportBadge[\s\S]*t\("detail\.byAuthor"\)[\s\S]*<dl className="grid grid-cols-3 divide-x divide-white\/8 border-t border-white\/8">/,
    "the author, support action, and metadata should stay inside one glass card",
  );
  assert.doesNotMatch(source, /library-detail-mobile-meta/);
});

test("mobile more actions live in the title row instead of over the gallery", () => {
  const mobileHeroStart = source.indexOf("A taller mobile gallery");
  const identityStart = source.indexOf("library-detail-content-shell", mobileHeroStart);
  const titleRowEnd = source.indexOf("\n        </section>", identityStart);

  assert.ok(mobileHeroStart >= 0 && identityStart > mobileHeroStart && titleRowEnd > identityStart);
  const mobileHero = source.slice(mobileHeroStart, identityStart);
  assert.match(mobileHero, /aspect-\[4\/3\][^"\n]*sm:aspect-\[3\/2\]/);
  assert.doesNotMatch(mobileHero, /crop=\{selectedItemCrop\.gallery\}/);
  assert.doesNotMatch(mobileHero, /<DropdownMenu>/);
  assert.match(source.slice(identityStart, titleRowEnd), /<h1 id="library-detail-title"[\s\S]*<DropdownMenu>/);
});

test("orphaned mobile details use the same taller centered gallery framing", () => {
  const orphanStart = source.indexOf("if (isOrphanedFork)");
  const orphanEnd = source.indexOf("\n  return (", orphanStart);

  assert.ok(orphanStart >= 0 && orphanEnd > orphanStart);
  const orphanMobile = source.slice(orphanStart, orphanEnd);
  assert.match(orphanMobile, /aspect-\[4\/3\][^"\n]*sm:aspect-\[3\/2\]/);
  assert.doesNotMatch(orphanMobile, /crop=\{selectedItemCrop\.gallery\}/);
});

test("publication status is not rendered as a tag-like classification chip", () => {
  const identityStart = source.indexOf("library-detail-content-shell");
  const identityEnd = source.indexOf("\n        </section>", identityStart);
  const overviewStart = source.indexOf('aria-labelledby="overview-heading"', identityEnd);
  const overviewEnd = source.indexOf("\n            </section>", overviewStart);

  assert.ok(identityStart >= 0 && identityEnd > identityStart);
  assert.ok(overviewStart > identityEnd && overviewEnd > overviewStart);

  const mobileIdentity = source.slice(identityStart, identityEnd);
  const mobileOverview = source.slice(overviewStart, overviewEnd);

  assert.doesNotMatch(mobileIdentity, /t\("detail\.(?:game|project)"\)/);
  assert.match(mobileIdentity, /\{isDraft && \([\s\S]*t\("detail\.draft"\)/);
  assert.doesNotMatch(mobileIdentity, /t\("detail\.published"\)/);
  assert.match(mobileIdentity, /<SupportBadge[\s\S]*<dl className="grid grid-cols-3 divide-x divide-white\/8 border-t border-white\/8">/);
  assert.match(mobileOverview, /\{tags\.map\(\(tag\) => \(/);
  assert.doesNotMatch(mobileOverview, /t\("detail\.(?:draft|published|game|project)"\)/);
});

test("engagement stats render directly below Overview from real world counters", () => {
  const overviewStart = source.indexOf('aria-labelledby="overview-heading"');
  const activityStart = source.indexOf("<LibraryDetailActivityCard", overviewStart);
  const reviewsStart = source.indexOf('aria-labelledby="reviews-heading"', activityStart);

  assert.ok(overviewStart >= 0 && activityStart > overviewStart);
  assert.ok(reviewsStart === -1 || activityStart < reviewsStart);
  assert.match(activitySource, /valueKey: "downloadCount", labelKey: "detail\.downloads", Icon: Download/);
  assert.match(activitySource, /valueKey: "messageCount", labelKey: "detail\.chatVolume", Icon: MessagesSquare/);
  assert.match(activitySource, /valueKey: "favoriteCount", labelKey: "detail\.favoriteCount", Icon: Heart/);
  assert.match(activitySource, /valueKey: "uniquePlayerCount", labelKey: "detail\.uniquePlayers", Icon: UsersRound/);
  assert.match(activitySource, /valueKey: "averageSessionSeconds", labelKey: "detail\.averageSession", Icon: Clock3/);
  assert.match(activitySource, /valueKey: "averageRating", labelKey: "detail\.averageRating", Icon: Star/);
  assert.match(activitySource, /showCreatorMetrics[\s\S]*CREATOR_ACTIVITY_METRICS/);
  assert.match(activitySource, /metrics\.map[\s\S]*format\(stats\[valueKey\]\)/);
  assert.match(activitySource, /<dt className="[^"]*min-w-0 flex-col[^"]*">[\s\S]*<span className="min-w-0 max-w-full break-words text-balance \[overflow-wrap:anywhere\]">/);
  assert.match(activitySource, /<dl className="grid grid-cols-3 pt-3">/);
  assert.match(activitySource, /index % 3 !== 2 \? "border-r border-white\/8"/);
  assert.match(activitySource, /index >= 3 \? "border-t border-white\/8"/);
  assert.doesNotMatch(activitySource, /<dl className="[^"]*(?:rounded|border|bg-)/);
  assert.match(desktopSource, /<LibraryDetailActivityCard[\s\S]*layout="desktop"[\s\S]*showCreatorMetrics=\{canViewCreatorAnalytics\}[\s\S]*stats=\{activityStats\}/);
  assert.match(source, /<LibraryDetailActivityCard[\s\S]*layout="mobile"[\s\S]*showCreatorMetrics=\{canViewCreatorAnalytics\}[\s\S]*stats=\{activityStats\}/);
});

test("published card details show bounded update history before bounded reviews", () => {
  const overviewStart = source.indexOf('aria-labelledby="overview-heading"');
  const activityStart = source.indexOf("<LibraryDetailActivityCard", overviewStart);
  const historyStart = source.indexOf('aria-labelledby="update-history-heading"', activityStart);
  const historyEnd = source.indexOf("\n              </section>", historyStart);
  const reviewsStart = source.indexOf('aria-labelledby="reviews-heading"', historyEnd);

  assert.ok(activityStart > overviewStart);
  assert.ok(historyStart > activityStart && historyEnd > historyStart);
  assert.ok(reviewsStart > historyEnd);
  assert.match(source.slice(historyStart, historyEnd), /<WorldUpdateHistory[\s\S]*creatorName=\{selectedItem\.creatorName\}/);
  assert.match(updateHistorySource, /max-h-80 overflow-y-auto/);
  assert.match(source, /max-h-\[32rem\] overflow-y-auto/);
  assert.doesNotMatch(updateHistorySource, /overscroll-contain/);
});

test("update history reads authored release notes safely and cancels stale requests", () => {
  assert.match(
    updateHistoryDataSource,
    /\/api\/worlds\/\$\{encodeURIComponent\(worldId\)\}\/updates/,
  );
  assert.match(updateHistoryDataSource, /credentials: "include", signal/);
  assert.match(updateHistoryDataSource, /body\.data\.map\(normalizeWorldUpdate\)/);
  assert.match(updateHistorySource, /signal: controller\.signal/);
  assert.match(updateHistorySource, /controller\.abort\(\)/);
  assert.match(updateHistorySource, /\{update\.title\}/);
  assert.match(updateHistorySource, /\{update\.content\}/);
  assert.match(updateHistorySource, /new Date\(update\.createdAt\)/);
});

test("author update notes support optional player-facing details", () => {
  assert.match(updateNotifySource, /const \[content, setContent\] = useState\(""\)/);
  assert.match(updateNotifySource, /await postWorldUpdateNote\(\{[\s\S]*content,[\s\S]*held,/);
  assert.match(updateNotifySource, /placeholder=\{t\("updateNotify\.detailsPlaceholder"\)\}/);
  // The failure stays inside the still-open dialog, next to the Notify button,
  // instead of a toast (feedback redesign R4).
  assert.match(updateNotifySource, /catch \{[\s\S]*setError\(t\("updateNotify\.failed"\)\)/);
  assert.match(updateNotifySource, /<FieldError id="update-notify-error" message=\{error\} \/>/);
  assert.match(updateNoteSource, /content: content\.trim\(\) \|\| undefined/);
  assert.match(updateNoteSource, /if \(!response\.ok\) \{[\s\S]*throw new Error/);
  assert.match(quickCreateSource, /held=\{hasPendingEdit\}/);
});

test("missing engagement counters are fetched from the existing single-world preview endpoint", () => {
  assert.match(
    statsSource,
    /\/api\/worlds\/\$\{encodeURIComponent\(worldId\)\}\?preview=true/,
  );
  assert.match(statsSource, /credentials: "include", signal: controller\.signal/);
  assert.match(statsSource, /response\.ok[\s\S]*body\.data[\s\S]*messageCount[\s\S]*favoriteCount/);
  assert.match(statsSource, /return \(\) => \{\s*ignore = true;\s*controller\.abort\(\);/);
  assert.match(source, /enabled: !isDraft && !isOrphanedFork/);
  assert.match(source, /reconcileFavoriteCount\(next\)/);
});

test("library data carries chat counters into synthetic detail items", () => {
  assert.match(worldsStoreSource, /messageCount\?: number \| null;[\s\S]*favoriteCount\?: number \| null;/);
  const syntheticStart = libraryGridSource.indexOf("const syntheticItem: WorldItem = {");
  const syntheticEnd = libraryGridSource.indexOf("\n      };", syntheticStart);

  assert.ok(syntheticStart >= 0 && syntheticEnd > syntheticStart);
  const syntheticItem = libraryGridSource.slice(syntheticStart, syntheticEnd);
  assert.match(syntheticItem, /messageCount: li\.worldMessageCount \?\? 0,/);
  assert.doesNotMatch(
    syntheticItem,
    /favoriteCount:/,
    "synthetic items should leave unavailable favorite counts undefined for detail hydration",
  );
});

test("engagement counts preserve zero and format missing values explicitly", () => {
  assert.equal(formatStatCount(undefined), "—");
  assert.equal(formatStatCount(null), "—");
  assert.equal(formatStatCount(0), "0");
  assert.equal(formatStatCount(1234), (1234).toLocaleString());
  assert.equal(formatAverageSession(undefined), "—");
  assert.equal(formatAverageSession(0), "0m");
  assert.equal(formatAverageSession(30), "<1m");
  assert.equal(formatAverageSession(90), "2m");
  assert.equal(formatAverageSession(3900), "1h 5m");
  assert.equal(formatAverageRating(undefined), "—");
  assert.equal(formatAverageRating(0), "—");
  assert.equal(formatAverageRating(4.67), "4.7");
});

test("every supported locale includes non-empty Activity labels", () => {
  for (const locale of ["en", "es", "ja", "zh", "zh-Hant"]) {
    const messages = JSON.parse(
      readFileSync(new URL(`../locales/${locale}/library.json`, import.meta.url), "utf8"),
    ) as { detail?: Record<string, unknown> };

    for (const key of activityLocaleKeys) {
      assert.equal(
        typeof messages.detail?.[key],
        "string",
        `${locale} should define detail.${key}`,
      );
      assert.ok(
        (messages.detail?.[key] as string).trim().length > 0,
        `${locale} detail.${key} should not be empty`,
      );
    }
  }
});

test("every supported locale includes update history and bounded-review labels", () => {
  for (const locale of ["en", "es", "ja", "zh", "zh-Hant"]) {
    const libraryMessages = JSON.parse(
      readFileSync(new URL(`../locales/${locale}/library.json`, import.meta.url), "utf8"),
    ) as { detail?: Record<string, unknown> };
    const editorMessages = JSON.parse(
      readFileSync(new URL(`../locales/${locale}/editor.json`, import.meta.url), "utf8"),
    ) as { updateNotify?: Record<string, unknown> };

    for (const key of updateHistoryLocaleKeys) {
      assert.equal(typeof libraryMessages.detail?.[key], "string", `${locale} should define detail.${key}`);
      assert.ok((libraryMessages.detail?.[key] as string).trim().length > 0);
    }
    assert.equal(typeof editorMessages.updateNotify?.detailsPlaceholder, "string");
    assert.ok((editorMessages.updateNotify?.detailsPlaceholder as string).trim().length > 0);
    assert.equal(typeof editorMessages.updateNotify?.failed, "string");
    assert.ok((editorMessages.updateNotify?.failed as string).trim().length > 0);
  }
});
