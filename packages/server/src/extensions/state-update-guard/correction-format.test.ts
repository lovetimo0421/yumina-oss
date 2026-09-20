import test from "node:test";
import assert from "node:assert/strict";
import { isJsonModeUnsupported, normalizeCorrectionJson } from "./correction-format.js";

const prefix = '{"narrative":"","status":"updated","stateChanges":[{"variableId":"relationships","operation":"merge","value":{"friend":{"note":"escaped \\\"quote\\\" and ]},\\n","affinity":4}}}]';
for (const closers of ["}", "]", "}]", "]}", " \n} \n] "]) {
  test(`recovers only excess closers at completed batch boundary: ${JSON.stringify(closers)}`, () => {
    const raw = prefix + closers + ',"review":[]}';
    assert.deepEqual(normalizeCorrectionJson(raw), { text: prefix + ',"review":[]}', repaired: true });
  });
}

for (const raw of [
  prefix + ',"review":[]}', // valid original stays byte-for-byte
  prefix + '}]}],"review":[]}', // more than two extra closers
  prefix + '}],"review":[],"status":"none"}', // overriding suffix
  prefix + '}],"review":[],"review":[]}', // duplicate review
  prefix.replace('"stateChanges":', '"review":[],"stateChanges":') + '}],"review":[]}',
  prefix.replace('"narrative":""', '"narrative":"","narrative":"rewrite"') + '}],"review":[]}',
  prefix.slice(0, -1) + '}],"review":[]}', // missing batch closing bracket
  prefix + '}],"review":[', // truncated trailing member
  prefix + '}],"review":[]} additional instructions',
  prefix + '}],"stateChanges":[]}',
  prefix.replace('"affinity":4', '"affinity":') + '}],"review":[]}',
  'The model refused.',
  '{"narrative":"","stateChanges":[]}],"review":[]}', // missing explicit status
  '{"narrative":"","status":"none","stateChanges":[]}],"review":{}}',
  'x'.repeat(65537),
]) {
  test(`does not infer/truncate/change ambiguous correction (${raw.length} chars: ${raw.slice(-50)})`, () => {
    assert.deepEqual(normalizeCorrectionJson(raw), { text: raw, repaired: false });
  });
}

test("complete fenced correction and thinking wrapper can use the same bounded recovery", () => {
  const raw = '<think>Internal planning.</think>\n```json\n' + prefix + '}],"review":[]}\n```';
  const result = normalizeCorrectionJson(raw);
  assert.equal(result.repaired, true);
  assert.deepEqual(JSON.parse(result.text), JSON.parse(prefix + ',"review":[]}'));
});

for (const message of ["400 response_format is not supported", "unsupported json_object", "responseMimeType application/json not supported", "400 Invalid parameter: response_format", "404 No endpoints found that support the requested parameters."]) {
  test(`identifies explicit JSON output incompatibility: ${message}`, () => assert.equal(isJsonModeUnsupported(new Error(message)), true));
}
for (const message of ["400 invalid parameter temperature", "No endpoints found", "invalid JSON reply", "401 response_format not supported", "403 unsupported json_object", "429 unsupported response_format", "503 unsupported response_format", "context length exceeded; response_format unsupported"]) {
  test(`does not reinterpret another error as format negotiation: ${message}`, () => assert.equal(isJsonModeUnsupported(new Error(message)), false));
}
