import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../db/index.js";
import { resolveCitedWorlds, type CitedWorld } from "./cited-worlds.js";

function world(
  id: string,
  language: string | null,
  languageGroupId: string | null,
  overrides: Partial<CitedWorld> = {},
): CitedWorld {
  return {
    id,
    name: id,
    description: null,
    thumbnailUrl: null,
    creatorId: "creator",
    language,
    languageGroupId,
    isPrimaryVariant: true,
    status: "published",
    isPublished: true,
    ageRating: "all",
    allowCommunityCitations: true,
    createdAt: new Date("2026-01-01"),
    downloadCount: 0,
    averageRating: 0,
    ...overrides,
  };
}

function fakeDb(candidates: CitedWorld[]) {
  let queryCount = 0;
  const rd = {
    select() {
      queryCount += 1;
      return {
        from() {
          return {
            async where() {
              return candidates;
            },
          };
        },
      };
    },
  } as unknown as Database;

  return { rd, queryCount: () => queryCount };
}

test("skips the candidate query when language or language groups are absent", async () => {
  const cited = world("standalone", "zh", null);
  const noLanguage = fakeDb([]);
  const noGroup = fakeDb([]);

  const unchangedWithoutLanguage = await resolveCitedWorlds(noLanguage.rd, [cited], null);
  const unchangedWithoutGroup = await resolveCitedWorlds(noGroup.rd, [cited], "en");

  assert.equal(noLanguage.queryCount(), 0);
  assert.equal(noGroup.queryCount(), 0);
  assert.equal(unchangedWithoutLanguage.get(cited.id), cited);
  assert.equal(unchangedWithoutGroup.get(cited.id), cited);
});

test("replaces a citation with the matching sibling row and keeps unmatched citations", async () => {
  const citedZh = world("group-1-zh", "zh", "group-1", { name: "中文卡" });
  const citedJa = world("group-2-ja", "ja", "group-2", { name: "日本語カード" });
  const englishSibling = world("group-1-en", "en", "group-1", {
    name: "English card",
    thumbnailUrl: "https://cdn.example/en.webp",
  });
  const fake = fakeDb([citedZh, englishSibling, citedJa]);

  const resolved = await resolveCitedWorlds(fake.rd, [citedZh, citedJa], "en");

  assert.equal(fake.queryCount(), 1);
  assert.deepEqual(resolved.get(citedZh.id), englishSibling);
  assert.equal(resolved.get(citedJa.id), citedJa);
});

test("never selects draft or unpublished siblings even if the query returns them", async () => {
  const citedZh = world("group-1-zh", "zh", "group-1");
  const draftEnglish = world("group-1-en-draft", "en", "group-1", { status: "draft" });
  const unpublishedEnglish = world("group-1-en-unpublished", "en", "group-1", {
    isPublished: false,
  });
  const fake = fakeDb([draftEnglish, unpublishedEnglish]);

  const resolved = await resolveCitedWorlds(fake.rd, [citedZh], "en");

  assert.equal(resolved.get(citedZh.id), citedZh);
});

test("never replaces a safe citation with an adult or citation-disabled sibling", async () => {
  const citedZh = world("group-1-zh", "zh", "group-1");
  const adultEnglish = world("group-1-en-adult", "en", "group-1", {
    ageRating: "r18",
  });
  const disabledEnglish = world("group-1-en-disabled", "en", "group-1", {
    allowCommunityCitations: false,
  });
  const fake = fakeDb([adultEnglish, disabledEnglish]);

  const resolved = await resolveCitedWorlds(fake.rd, [citedZh], "en");

  assert.equal(resolved.get(citedZh.id), citedZh);
});

test("keeps the cited row without querying when it already matches the viewer language", async () => {
  const citedEn = world("group-1-en", "en", "group-1");
  const fake = fakeDb([citedEn, world("group-1-en-alt", "en-US", "group-1")]);

  const resolved = await resolveCitedWorlds(fake.rd, [citedEn], "en");

  assert.equal(fake.queryCount(), 0);
  assert.equal(resolved.get(citedEn.id), citedEn);
});
