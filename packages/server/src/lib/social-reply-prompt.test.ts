import assert from "node:assert/strict";
import test from "node:test";
import { buildSocialReplyPrompt, renderSocialContext, selectSocialGuidance } from "./social-reply-prompt.js";
import { applySocialAction, initialSocialState, socialJobContext, type SocialJob } from "@yumina/engine";
import { MAX_PERSONA_NAME, MAX_PERSONA_APPEARANCE, MAX_PERSONA_PERSONALITY, MAX_PERSONA_BACKSTORY, personaEntriesSchema } from "@yumina/shared";

const sheets = (prompt: string) => prompt.split("\nCharacters:\n")[1]!.split("\n\nSession scenario / player:\n")[0]!.split("\n\n## ").map((s, i) => i === 0 ? s.replace(/^## /, "") : s);

test("social instructions distinguish public surfaces and constrain personal cross-surface memory", () => {
    const job: SocialJob = { id: "r", kind: "refresh", targetId: "timeline", members: ["a"], status: "running" };
    const prompt = buildSocialReplyPrompt(job, [{ id: "a", name: "A", lore: "A quiet musician." }]);
    for (const text of ["standalone PUBLIC social posts", "There is NO incoming message to answer", "PUBLIC COMMENTS", "one-to-one PRIVATE chat", "group-message/channel", "belongs to that character ONLY", "do not quote, recount or hint at private messages", "timelinePlan", "Remembering something does not mean broadcasting it"])
        assert.ok(prompt.includes(text), text);
    assert.ok(prompt.includes("CREATE NEW STANDALONE PUBLIC POSTS"));
    assert.ok(prompt.includes("NOT a current request"));
    assert.ok(!buildSocialReplyPrompt({ ...job, kind: "post" }, []).includes("CURRENT TASK: CREATE NEW"));
});

test("a timeline refresh asks every member to post; replies and comments let unaddressed members stay silent", () => {
    for (const count of [1, 3, 6]) {
        const members = Array.from({ length: count }, (_, i) => `member-${i}`);
        const lore = members.map(id => ({ id, name: id, lore: `Character ${id}` }));
        const refresh = buildSocialReplyPrompt({ id: "r", targetId: "timeline", kind: "refresh", members, status: "running" }, lore);
        assert.ok(refresh.includes(`Write exactly ${count} messages: one new post from every listed member`));
        assert.ok(refresh.includes("no missing or duplicate authorId"));
        for (const kind of ["post", "message"] as const) {
            const prompt = buildSocialReplyPrompt({ id: "p", targetId: "p", kind, members, status: "running" }, lore);
            if (count === 1) assert.ok(prompt.includes("Write exactly 1 message, from member-0."));
            else {
                assert.ok(prompt.includes(`Write between 1 and ${count} messages, each from a different member of: ${members.join(", ")}`));
                assert.ok(prompt.includes("Anyone addressed by name or clearly asked something must answer"));
                assert.ok(prompt.includes("Do not make everyone chime in"));
            }
            for (const member of lore) assert.ok(prompt.includes(`## ${member.name} (authorId: ${member.id})\n${member.lore}`));
        }
    }
});

test("the session scenario follows the character sheets and is declared to win on setting and roles", () => {
    const job: SocialJob = { id: "p", targetId: "p", kind: "message", members: ["josh"], status: "running" };
    const prompt = buildSocialReplyPrompt(job, [{ id: "josh", name: "Joshua", lore: "Idol, vocal unit." }], { name: "小月", backstory: "Mafia AU: Joshua leads the organisation." });
    const characters = prompt.indexOf("\nCharacters:\n"), scenario = prompt.indexOf("\nSession scenario / player:\n");
    assert.ok(characters > 0 && scenario > characters, "scenario must come after the sheets, nearest the generation point");
    assert.ok(prompt.includes("the scenario wins, while personality, habits and voice still come from the sheet"));
    assert.ok(prompt.slice(scenario).includes("Mafia AU: Joshua leads the organisation."));
    const macro = buildSocialReplyPrompt(job, [], { name: "小月", backstory: "## 璃娅｜{{user}}\n{{USER}} owes them money." });
    assert.ok(macro.includes("## 璃娅｜小月\n小月 owes them money."), "persona text resolves {{user}} to the persona name");
});

test("creator notes come from the card's always-on non-character entries, deduplicated, with {{user}} resolved", () => {
    const entries = [
        { id: "task", name: "Task", content: "你正在模拟角色使用社交软件。", section: "system-presets", role: "system", alwaysSend: true },
        { id: "instructions", name: "Instructions", content: "你正在模拟角色使用社交软件。", section: "system-presets", role: "system", alwaysSend: true },
        { id: "style", name: "Style", content: "<style>像本人随手用手机回复 {{user}}。</style>", section: "system-presets", role: "system", alwaysSend: true },
        { id: "josh", name: "Joshua", content: "Idol.", section: "system-presets", role: "custom", alwaysSend: true },
        { id: "greeting", name: "Opening", content: "Greeting text", section: "system-presets", role: "greeting", alwaysSend: true },
        { id: "cot", name: "CoT Bypass", content: "<think>skip</think>", section: "post-history", role: "system", alwaysSend: true },
        { id: "keyword", name: "Keyed", content: "Only on keyword", section: "system-presets", role: "custom", keys: ["seoul"] },
        { id: "off", name: "Disabled", content: "Disabled text", section: "system-presets", role: "system", enabled: false },
        { id: "blank", name: "Blank", content: "   ", section: "system-presets", role: "system" },
    ];
    const guidance = selectSocialGuidance(entries, ["josh"], "小月")!;
    assert.equal(guidance, "你正在模拟角色使用社交软件。\n\n<style>像本人随手用手机回复 小月。</style>");
    assert.equal(selectSocialGuidance(entries.slice(3), ["josh"]), undefined);
    assert.equal(selectSocialGuidance([entries[2]!], []), "<style>像本人随手用手机回复 the player。</style>");
    const prompt = buildSocialReplyPrompt({ id: "p", targetId: "p", kind: "post", members: ["josh"], status: "running" }, [{ id: "josh", name: "Joshua", lore: "Idol." }], null, guidance);
    assert.ok(prompt.includes("\nCreator notes:\n你正在模拟角色使用社交软件。"));
    assert.ok(!prompt.includes("<game-state>"));
    const withCast = buildSocialReplyPrompt({ id: "p", targetId: "p", kind: "post", members: ["josh"], status: "running" }, [{ id: "josh", name: "Joshua", lore: "Idol." }], null, guidance, ["josh", "coups"]);
    assert.ok(withCast.includes('<game-state>\nselected-members: ["josh"]\n</game-state>'), "selected-members names this reply's speakers, not the whole session cast");
    assert.ok(!withCast.includes("coups"), "members outside the batch are never offered as speakers");
    assert.ok(withCast.trimEnd().endsWith("a reply with an unlisted authorId is discarded whole."), "the allowed list is restated last, after the scenario");
    assert.ok(!buildSocialReplyPrompt({ id: "p", targetId: "p", kind: "post", members: ["josh"], status: "running" }, [], null).includes("Creator notes:"));
});

test("custom persona entries reach social replies without overflowing the request budget", () => {
    const job: SocialJob = { id: "p", targetId: "p", kind: "post", members: ["a"], status: "running" };
    const entry = { title: "Weapons", content: "{{user}} uses a steel sword." };
    assert.ok(buildSocialReplyPrompt(job, [], { name: "Alex", entries: [entry] }).includes("Weapons: Alex uses a steel sword."));
    const full = buildSocialReplyPrompt(job, [{ id: "a", name: "A", lore: "L".repeat(6000) }], {
        name: "Alex", backstory: "B".repeat(5000), entries: Array(4).fill({ title: "Ability", content: "X".repeat(4990) }),
    }, "G".repeat(5000));
    assert.ok(full.length + 25000 < 50000);
});

test("emoji-heavy custom entries obey the endpoint's UTF-16 request budget", () => {
    const members = Array.from({ length: 6 }, (_, i) => `member-${i}`);
    const job: SocialJob = { id: "p", targetId: "p", kind: "post", members, status: "running" };
    const entries = personaEntriesSchema.parse(Array(4).fill({ title: "A", content: "😀".repeat(2499) }));
    const persona = { name: "Alex", appearance: "A".repeat(MAX_PERSONA_APPEARANCE),
        personality: "P".repeat(MAX_PERSONA_PERSONALITY), backstory: "B".repeat(MAX_PERSONA_BACKSTORY), entries };
    for (const guidance of ["G".repeat(5000), "😀".repeat(5000)]) {
        const prompt = buildSocialReplyPrompt(job, members.map(id => ({ id, name: id, lore: "😀".repeat(6000) })), persona, guidance, members);
        assert.ok(prompt.length + 25000 < 50000, `request is ${prompt.length + 25000} UTF-16 characters`);
        assert.ok(prompt.includes("A: 😀"), "custom entries remain included");
        assert.doesNotMatch(prompt, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "clipping never leaves a split surrogate pair");
        assert.equal(sheets(prompt).length, members.length);
    }
});

test("the full allowed persona and creator notes survive six long character profiles under the 50k request limit", () => {
    const members = Array.from({ length: 6 }, (_, i) => `member-${i}`);
    const job: SocialJob = { id: "p", targetId: "p", kind: "post", members, status: "running" };
    const relationship = "My spouse is Mira. Everyone else is a colleague.";
    const persona = {
        name: "N".repeat(MAX_PERSONA_NAME),
        appearance: "A".repeat(MAX_PERSONA_APPEARANCE),
        personality: "P".repeat(MAX_PERSONA_PERSONALITY),
        backstory: "B".repeat(MAX_PERSONA_BACKSTORY - relationship.length) + relationship,
        description: "PRIVATE_ORGANIZATION_NOTE_DO_NOT_SEND",
    };
    const guidance = "G".repeat(9000);
    const prompt = buildSocialReplyPrompt(job, members.map(id => ({ id, name: id, lore: '\\"😀'.repeat(6000) })), persona, guidance);
    for (const field of [persona.name, persona.appearance, persona.personality, persona.backstory]) assert.ok(prompt.includes(field));
    assert.ok(!prompt.includes(persona.description));
    assert.ok(prompt.includes("G".repeat(5000)) && !prompt.includes("G".repeat(5001)), "creator notes are clipped, never dropped");
    const lore = sheets(prompt);
    assert.equal(lore.length, 6);
    for (const member of lore) assert.ok(member.split("\n")[1]!.length > 0, "every sheet keeps some lore");
    assert.ok(prompt.length + 25000 < 50000, `system prompt is ${prompt.length} chars`);
});

test("null and alternate synthetic personas cannot inherit another player's identity or relationship", () => {
    const job: SocialJob = { id: "p", targetId: "p", kind: "post", members: ["mira"], status: "running" };
    const lore = [{ id: "mira", name: "Mira", lore: "An astronomer." }];
    const first = buildSocialReplyPrompt(job, lore, { name: "Synthetic Alex", backstory: "Mira is my spouse." });
    const second = buildSocialReplyPrompt(job, lore, { name: "Synthetic Robin", appearance: "Blue jacket", personality: "Reserved", backstory: "Mira is my research supervisor." });
    assert.ok(first.includes("Synthetic Alex"));
    assert.ok(first.includes("Mira is my spouse."));
    for (const text of ["Synthetic Robin", "Blue jacket", "Reserved", "Mira is my research supervisor."]) assert.ok(second.includes(text));
    assert.ok(!second.includes("Synthetic Alex"));
    assert.ok(!second.includes("Mira is my spouse."));
    const empty = buildSocialReplyPrompt(job, lore, null);
    assert.equal(empty, buildSocialReplyPrompt(job, lore));
    assert.ok(!empty.includes("[User Persona]"));
    assert.ok(!empty.includes("Session scenario / player:"));
    assert.ok(!empty.includes("Synthetic Alex"));
    assert.ok(!empty.includes("Synthetic Robin"));
});

test("six long and heavily escaped character descriptions fit beside a full rendered conversation", () => {
    const profiles = Array.from({ length: 6 }, (_, i) => ({ id: `member-${i}`, name: `Member ${i}`, handle: `${i}`, avatar: "", loreEntryId: `${i}` }));
    const config = { profiles };
    let state = applySocialAction(initialSocialState(config), { type: "conversation", id: "c", name: "Group", members: profiles.map(p => p.id), channel: true }, config, "now");
    state.conversations[0]!.messages = Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, authorId: "you", text: "".repeat(2000), createdAt: "now" }));
    state = applySocialAction(state, { type: "message", id: "p", conversationId: "c", text: "Latest message" }, config, "now");
    const job = state.jobs[0]!;
    const prompt = buildSocialReplyPrompt(job, profiles.map(p => ({ id: p.id, name: p.name, lore: '\\"😀'.repeat(6000) })), null, "S".repeat(5000));
    const context = socialJobContext(state, job);
    const rendered = renderSocialContext(context);
    assert.ok(rendered.length <= JSON.stringify(context).length, "prose never exceeds the JSON the engine budgeted");
    assert.ok(prompt.length + rendered.length < 50000);
    assert.ok(rendered.includes("Latest message (respond to this) — you: Latest message"));
    assert.equal(sheets(prompt).length, 6);
});

test("the rendered context reads as a labelled transcript for every surface and keeps memory buckets per character", () => {
    const profiles = ["a", "b"].map(id => ({ id, name: id.toUpperCase(), handle: id, avatar: "", loreEntryId: id }));
    const config = { profiles };
    let s = applySocialAction(initialSocialState(config), { type: "post", id: "root", text: "Anyone awake?" }, config, "t1");
    s.jobs[0]!.status = "done";
    s.posts.push({ id: "root:ai:0", authorId: "a", text: "Always.", parentId: "root", createdAt: "t2", likes: [], reposts: [] });
    s = applySocialAction(s, { type: "post", id: "follow", parentId: "root:ai:0", text: "Go to sleep, A" }, config, "t3");
    const reply = renderSocialContext(socialJobContext(s, s.jobs.at(-1)!));
    assert.ok(reply.startsWith("Surface: public-reply"));
    assert.ok(reply.includes("Root post — you: Anyone awake?"));
    assert.ok(reply.includes("Thread replies (oldest first):\na: Always."));
    assert.ok(reply.includes("Latest in thread (respond to this) — you: Go to sleep, A"));
    assert.ok(!reply.includes('"authorId"'), "no raw JSON when the shape is known");

    s = applySocialAction(s, { type: "conversation", id: "dm", name: "A", members: ["a"], channel: false }, config, "t4");
    s = applySocialAction(s, { type: "message", id: "m", conversationId: "dm", text: "secret plan" }, config, "t5");
    const dm = renderSocialContext(socialJobContext(s, s.jobs.at(-1)!));
    assert.ok(dm.startsWith('Surface: private-message "A"'));
    assert.ok(dm.includes("Public activity (recorded, background only):\n- you posted: Anyone awake?"));
    assert.ok(dm.includes("- you posted: Anyone awake?\n  ↳ a replied: Always.\n- a posted: Always.\n  ↳ you replied: Go to sleep, A"));
    assert.ok(dm.includes("Conversation (live chat, oldest first):\nyou: secret plan"));
    assert.ok(dm.includes("Latest message (respond to this) — you: secret plan"));
    assert.ok(dm.includes("Memory of a (only a knows this; background, not new messages):"));
    assert.ok(dm.includes("- [public-comment] a: Always. (replying to you: Anyone awake?)"));

    s = applySocialAction(s, { type: "refresh", id: "r" }, config, "t6");
    const timeline = renderSocialContext(socialJobContext(s, s.jobs.at(-1)!));
    assert.ok(timeline.startsWith("Surface: public-timeline"));
    assert.ok(timeline.includes("Timeline plan (one post per member):\n- "));
    assert.ok(timeline.includes("Earlier public posts (for continuity only, oldest first):\nyou: Anyone awake?"));
    assert.ok(timeline.includes("Current task: 现在发布全新的独立公开动态"));
    assert.ok(renderSocialContext({ kind: "mystery", extra: { x: 1 } }).includes('Additional context: {"extra":{"x":1}}'));
});
