import assert from "node:assert/strict";
import test from "node:test";
import { applySocialAction, initialSocialState, type SocialState } from "@yumina/engine";
import { generateSocialReplies, readSocialCompletion, type SocialCompletionMessages } from "./social-generation.js";

const config = { profiles: ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase(), handle: id, avatar: '', loreEntryId: id })) };
const lore = config.profiles.map(p => ({ ...p, lore: `SHEET_${p.id}` }));
const act = (s: SocialState, a: unknown) => applySocialAction(s, a, config, '2026-09-15T00:00:00Z');
function fixture(kind: 'post' | 'refresh' | 'message') {
    let s = initialSocialState(config);
    for (const [id, members, text] of [['dm-a', ['a'], 'PRIVATE_A_ILLNESS'], ['dm-b', ['b'], 'PRIVATE_B_JOB'], ['old-group', ['a', 'b'], 'AB_ONLY_EVENT']] as const) {
        s = act(s, { type: 'conversation', id, members: [...members], name: id, channel: false });
        s = act(s, { type: 'message', id: `${id}-message`, conversationId: id, text });
        s.jobs.at(-1)!.status = 'done';
    }
    if (kind === 'message') s = act(s, { type: 'conversation', id: 'current', members: ['a', 'b', 'c'], name: 'Everyone', channel: false });
    s = act(s, kind === 'message' ? { type: kind, id: 'trigger', conversationId: 'current', text: 'Ordinary question' }
        : kind === 'post' ? { type: kind, id: 'trigger', text: 'An ordinary public day' } : { type: kind, id: 'trigger' });
    return JSON.parse(JSON.stringify(s)) as SocialState;
}
const speakers = (messages: SocialCompletionMessages) => /ALLOWED authorId values for this reply: ([^.]+)\./.exec(messages[0]!.content)![1]!.split(', ');
const reply = (messages: SocialCompletionMessages) => ({ messages: speakers(messages).map(authorId => ({ authorId, text: 'A short reply.' })) });

for (const kind of ['post', 'refresh', 'message'] as const) {
    test(`${kind}: the provider receives only records known to the destination audience`, async () => {
        const state = fixture(kind), original = structuredClone(state);
        let calls = 0;
        const result = await generateSocialReplies(state, state.jobs.at(-1)!, lore, null, 'Creator tone', async messages => {
            calls++;
            const request = JSON.stringify(messages);
            for (const secret of ['PRIVATE_A_ILLNESS', 'PRIVATE_B_JOB', 'AB_ONLY_EVENT']) assert.ok(!request.includes(secret), secret);
            assert.ok(request.includes('Creator tone'));
            return reply(messages);
        });
        assert.equal(calls, 1, 'audience isolation must not multiply billed model calls');
        assert.deepEqual(result.messages.map(m => m.authorId), state.jobs.at(-1)!.members);
        assert.deepEqual(state, original, 'private memory remains stored for future private chats');
    });
}

test('a channel with new members cannot accidentally recount history they never heard', async () => {
    let s = initialSocialState(config);
    s = act(s, { type: 'conversation', id: 'channel', members: ['a', 'b'], name: 'Channel', channel: true });
    s = act(s, { type: 'message', id: 'old', conversationId: 'channel', text: 'BEFORE_C_JOINED' });
    for (const m of s.conversations[0]!.messages) delete m.audience;
    s = act(s, { type: 'members', id: 'join', conversationId: 'channel', members: ['a', 'b', 'c'] });
    s = act(s, { type: 'message', id: 'new', conversationId: 'channel', text: 'AFTER_C_JOINED' });
    // Even a batch of original members must respect the ENTIRE audience,
    // not only whoever happens to reply in this batch.
    await generateSocialReplies(s, { ...s.jobs.at(-1)!, members: ['a', 'b'] }, lore, null, undefined, async messages => {
        const text = JSON.stringify(messages);
        assert.ok(!text.includes('BEFORE_C_JOINED'));
        assert.ok(text.includes('AFTER_C_JOINED'));
        return reply(messages);
    });
});

test('one-to-one chat retains the same character memory without importing other DMs', async () => {
    let s = fixture('post'); s.jobs.at(-1)!.status = 'done';
    s = act(s, { type: 'message', id: 'recall', conversationId: 'dm-a', text: 'Remember what I told you?' });
    await generateSocialReplies(s, s.jobs.at(-1)!, lore, null, undefined, async messages => {
        const text = JSON.stringify(messages);
        assert.ok(text.includes('PRIVATE_A_ILLNESS'));
        assert.ok(text.includes('AB_ONLY_EVENT'));
        assert.ok(!text.includes('PRIVATE_B_JOB'));
        assert.ok(!text.includes('SHEET_b'));
        assert.ok(text.includes('An ordinary public day'));
        return reply(messages);
    });
});

test('another group with the same audience retains shared history, but not individual DMs', async () => {
    let s = fixture('post'); s.jobs.at(-1)!.status = 'done';
    s = act(s, { type: 'conversation', id: 'new-ab', members: ['a', 'b'], name: 'AB again', channel: false });
    s = act(s, { type: 'message', id: 'recall', conversationId: 'new-ab', text: 'Our shared plan?' });
    await generateSocialReplies(s, s.jobs.at(-1)!, lore, null, undefined, async messages => {
        const text = JSON.stringify(messages);
        assert.ok(text.includes('AB_ONLY_EVENT'));
        assert.ok(!text.includes('PRIVATE_A_ILLNESS'));
        assert.ok(!text.includes('PRIVATE_B_JOB'));
        return reply(messages);
    });
});

test('silent peers remain optional and chat fragments survive to the engine', async () => {
    const state = fixture('message'), job = { ...state.jobs.at(-1)!, members: ['a', 'b', 'c'] };
    const expected = { messages: [{ authorId: 'b', text: 'Hey' }, { authorId: 'b', text: 'How was it?' }] };
    const result = await generateSocialReplies(state, job, lore, null, undefined, async messages => {
        assert.ok(messages[0]!.content.includes('Decide who would actually respond'));
        return expected;
    });
    assert.deepEqual(result, expected);
});

test('malformed, empty and oversized replies fail before persistence', async () => {
    const state = fixture('message'), job = state.jobs.at(-1)!;
    for (const response of [null, { messages: [] }, { messages: [{ authorId: 'a', text: 'x'.repeat(281) }] }]) {
        await assert.rejects(generateSocialReplies(state, job, lore, null, undefined, async () => response));
    }
});

test('a provider failure is propagated without extra charged calls', async () => {
    const state = fixture('post');
    let calls = 0;
    await assert.rejects(generateSocialReplies(state, state.jobs.at(-1)!, lore, null, undefined, async () => {
        calls++;
        throw new Error('Provider unavailable');
    }), /Provider unavailable/);
    assert.equal(calls, 1);
});

test('SSE reader handles fragmented UTF-8 and done events and closes its stream', async () => {
    const result = { messages: [{ authorId: 'a', text: '你好' }] };
    const bytes = new TextEncoder().encode(`event: text\ndata: {"content":"ignored"}\n\nevent: done\ndata: ${JSON.stringify({ content: '```json\n' + JSON.stringify(result) + '\n```' })}\n\n`);
    let cancelled = false;
    const response = new Response(new ReadableStream({
        start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); },
        cancel() { cancelled = true; },
    }));
    assert.deepEqual(await readSocialCompletion(response, new AbortController().signal), result);
    assert.ok(cancelled);
});

test('SSE cancellation closes a blocked reader and never returns partial output', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const controller = new AbortController();
    const pending = readSocialCompletion(response, controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled or timed out/);
    assert.ok(cancelled);
});

test('SSE handles pre-abort, provider errors, HTTP errors and incomplete output', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(readSocialCompletion(new Response(''), controller.signal), /cancelled/);
    await assert.rejects(readSocialCompletion(new Response('{"error":"No credits"}', { status: 402 }), new AbortController().signal), /No credits/);
    await assert.rejects(readSocialCompletion(new Response('event: error\ndata: {"error":"Unavailable"}\n\n'), new AbortController().signal), /Unavailable/);
    await assert.rejects(readSocialCompletion(new Response('event: text\ndata: {"content":"partial"}\n\n'), new AbortController().signal), /cancelled or timed out/);
});
