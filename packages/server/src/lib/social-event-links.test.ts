import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSocialAccountKey, normalizeSocialPostUrl, resolveSocialPostUrl } from "./social-event-links.js";

test("normalizes X aliases and removes tracking parameters", () => {
  assert.deepEqual(
    normalizeSocialPostUrl("x", "https://mobile.twitter.com/Yumina/status/123?s=20#fragment"),
    {
      canonicalUrl: "https://x.com/i/status/123",
      canonicalPostKey: "x:x.com/i/status/123",
      riskFlags: [],
    },
  );
});

test("keeps the YouTube video id while removing tracking", () => {
  assert.deepEqual(
    normalizeSocialPostUrl("youtube", "https://www.youtube.com/watch?v=abc123&utm_source=test"),
    {
      canonicalUrl: "https://youtube.com/watch?v=abc123",
      canonicalPostKey: "youtube:youtube.com/watch?v=abc123",
      riskFlags: [],
    },
  );
});

test("normalizes YouTube shorts to the same stable video key", () => {
  assert.equal(
    normalizeSocialPostUrl("youtube", "https://youtube.com/shorts/abc123?feature=share").canonicalPostKey,
    normalizeSocialPostUrl("youtube", "https://youtube.com/watch?v=abc123").canonicalPostKey,
  );
});

test("uses stable ids instead of mutable account paths", () => {
  assert.equal(
    normalizeSocialPostUrl("x", "https://x.com/FirstName/status/987").canonicalPostKey,
    normalizeSocialPostUrl("x", "https://x.com/otherNAME/status/987").canonicalPostKey,
  );
  assert.equal(
    normalizeSocialPostUrl("tiktok", "https://www.tiktok.com/@one/video/12345").canonicalPostKey,
    normalizeSocialPostUrl("tiktok", "https://www.tiktok.com/@two/video/12345").canonicalPostKey,
  );
  assert.equal(
    normalizeSocialPostUrl("reddit", "https://reddit.com/r/a/comments/AbC123/title").canonicalPostKey,
    "reddit:reddit.com/comments/abc123",
  );
});

test("accepts unresolved short links for manual review", () => {
  assert.deepEqual(
    normalizeSocialPostUrl("bilibili", "https://b23.tv/abcXYZ#share"),
    {
      canonicalUrl: "https://b23.tv/abcXYZ",
      canonicalPostKey: "bilibili:url:https://b23.tv/abcXYZ",
      riskFlags: ["manual_review_url", "short_link"],
    },
  );
  assert.deepEqual(
    normalizeSocialPostUrl("douyin", "https://v.douyin.com/abcXYZ?share_token=keep"),
    {
      canonicalUrl: "https://v.douyin.com/abcXYZ?share_token=keep",
      canonicalPostKey: "douyin:url:https://v.douyin.com/abcXYZ?share_token=keep",
      riskFlags: ["manual_review_url", "short_link"],
    },
  );
});

test("resolves short links before deriving the reward claim key", async () => {
  const destinations = new Map([
    ["https://b23.tv/first", "https://www.bilibili.com/video/BV1abc123?share_source=copy_web"],
    ["https://b23.tv/second", "https://www.bilibili.com/video/BV1abc123?spm_id_from=333"],
  ]);
  const fetchImpl = (async (input: string | URL | Request) => {
    const location = destinations.get(String(input));
    return new Response(null, location
      ? { status: 302, headers: { location } }
      : { status: 404 });
  }) as typeof fetch;

  const first = await resolveSocialPostUrl("bilibili", "https://b23.tv/first", fetchImpl);
  const second = await resolveSocialPostUrl("bilibili", "https://b23.tv/second", fetchImpl);
  assert.equal(first.canonicalPostKey, "bilibili:bilibili.com/video/BV1abc123");
  assert.equal(second.canonicalPostKey, first.canonicalPostKey);
});

test("accepts off-platform URLs for manual review instead of rejecting", async () => {
  const result = await resolveSocialPostUrl("xiaohongshu", "https://share.example.com/post/abc?token=123");
  assert.deepEqual(result.riskFlags, ["manual_review_url", "platform_mismatch"]);
  assert.equal(result.canonicalPostKey, "xiaohongshu:url:https://share.example.com/post/abc");
  const noRedirect = (async () => new Response(null, { status: 200 })) as typeof fetch;
  await assert.rejects(
    resolveSocialPostUrl("douyin", "https://v.douyin.com/unresolved", noRedirect),
    /SOCIAL_SHORT_LINK_RESOLUTION_FAILED/,
  );
});

test("accepts another platform or unknown host for manual review", () => {
  assert.deepEqual(
    normalizeSocialPostUrl("instagram", "https://x.com/yumina/status/123"),
    {
      canonicalUrl: "https://x.com/yumina/status/123",
      canonicalPostKey: "instagram:url:https://x.com/yumina/status/123",
      riskFlags: ["manual_review_url", "platform_mismatch"],
    },
  );
  assert.deepEqual(
    normalizeSocialPostUrl("xiaohongshu", "https://share.example.com/post/abc?token=123#preview"),
    {
      canonicalUrl: "https://share.example.com/post/abc",
      canonicalPostKey: "xiaohongshu:url:https://share.example.com/post/abc",
      riskFlags: ["manual_review_url", "platform_mismatch"],
    },
  );
});

test("accepts an unrecognized post path on a known host with a query-stripped key", () => {
  assert.deepEqual(
    normalizeSocialPostUrl("instagram", "https://instagram.com/yumina/stories/1?ref=share"),
    {
      canonicalUrl: "https://instagram.com/yumina/stories/1",
      canonicalPostKey: "instagram:url:https://instagram.com/yumina/stories/1",
      riskFlags: ["manual_review_url", "unrecognized_post_format"],
    },
  );
  // Query variants of the same unknown-format URL collapse to one claim key.
  assert.equal(
    normalizeSocialPostUrl("weibo", "https://video.weibo.com/show?fid=1#a").canonicalPostKey,
    normalizeSocialPostUrl("weibo", "https://video.weibo.com/show?fid=2").canonicalPostKey,
  );
});

test("resolve accepts right-platform URLs with unknown formats instead of rejecting", async () => {
  const result = await resolveSocialPostUrl("instagram", "https://instagram.com/yumina/stories/1?ref=x");
  assert.deepEqual(result.riskFlags, ["manual_review_url", "unrecognized_post_format"]);
  assert.equal(result.canonicalPostKey, "instagram:url:https://instagram.com/yumina/stories/1");
});

test("resolves xhslink.cn short links like xhslink.com", async () => {
  const destinations = new Map([
    ["http://xhslink.cn/o/2fr3aQNegkq", "https://www.xiaohongshu.com/explore/68a1b2c3d4?xsec_token=abc"],
  ]);
  const fetchImpl = (async (input: string | URL | Request) => {
    const location = destinations.get(String(input));
    return new Response(null, location
      ? { status: 302, headers: { location } }
      : { status: 404 });
  }) as typeof fetch;

  assert.equal(
    (await resolveSocialPostUrl("xiaohongshu", "http://xhslink.cn/o/2fr3aQNegkq", fetchImpl)).canonicalPostKey,
    "xiaohongshu:xiaohongshu.com/explore/68a1b2c3d4",
  );
});

test("recognizes note, opus, article and status content types", () => {
  assert.equal(
    normalizeSocialPostUrl("douyin", "https://www.douyin.com/note/7123456789?prev=web").canonicalPostKey,
    "douyin:douyin.com/note/7123456789",
  );
  assert.equal(
    normalizeSocialPostUrl("bilibili", "https://t.bilibili.com/987654321?share_from=app").canonicalPostKey,
    "bilibili:bilibili.com/opus/987654321",
  );
  assert.equal(
    normalizeSocialPostUrl("bilibili", "https://www.bilibili.com/opus/987654321").canonicalPostKey,
    "bilibili:bilibili.com/opus/987654321",
  );
  assert.equal(
    normalizeSocialPostUrl("bilibili", "https://www.bilibili.com/read/cv123456?from=search").canonicalPostKey,
    "bilibili:bilibili.com/read/cv123456",
  );
  assert.equal(
    normalizeSocialPostUrl("weibo", "https://m.weibo.cn/status/N8abc123?wm=share").canonicalPostKey,
    "weibo:weibo.com/detail/N8abc123",
  );
  assert.equal(
    normalizeSocialPostUrl("threads", "https://www.threads.com/@yumina/post/C8abc?igsh=1").canonicalPostKey,
    normalizeSocialPostUrl("threads", "https://www.threads.net/@yumina/post/C8abc").canonicalPostKey,
  );
});

test("resolves same-host share paths like short links", async () => {
  const destinations = new Map([
    ["https://www.tiktok.com/t/ZTabc123", "https://www.tiktok.com/@user/video/7100000001?_t=8a&_r=1"],
    ["https://www.reddit.com/r/yumina/s/AbCd12", "https://www.reddit.com/r/yumina/comments/1xyz89/title/?share_id=q"],
    ["https://t.cn/A6abc", "https://weibo.com/1234567/N8abc123?type=comment"],
  ]);
  const fetchImpl = (async (input: string | URL | Request) => {
    const location = destinations.get(String(input));
    return new Response(null, location
      ? { status: 302, headers: { location } }
      : { status: 404 });
  }) as typeof fetch;

  assert.equal(
    (await resolveSocialPostUrl("tiktok", "https://www.tiktok.com/t/ZTabc123", fetchImpl)).canonicalPostKey,
    "tiktok:tiktok.com/video/7100000001",
  );
  assert.equal(
    (await resolveSocialPostUrl("reddit", "https://www.reddit.com/r/yumina/s/AbCd12", fetchImpl)).canonicalPostKey,
    "reddit:reddit.com/comments/1xyz89",
  );
  assert.equal(
    (await resolveSocialPostUrl("weibo", "https://t.cn/A6abc", fetchImpl)).canonicalPostKey,
    "weibo:weibo.com/detail/N8abc123",
  );
});

test("still rejects values that are not http or https links", () => {
  assert.throws(() => normalizeSocialPostUrl("x", "not a link"), /INVALID_SOCIAL_URL/);
  assert.throws(
    () => normalizeSocialPostUrl("x", "javascript:alert(1)"),
    /INVALID_SOCIAL_URL_PROTOCOL/,
  );
});

test("normalizes account keys consistently", () => {
  assert.equal(normalizeSocialAccountKey("  @YUMINA  "), "yumina");
});
