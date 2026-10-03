import assert from "node:assert/strict";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { hashPassword } from "better-auth/crypto";
import { usernameAuthPlugin } from "./auth-username.js";

const readAuthResponse = async (response: Response) => await response.json() as {
  code?: string;
  token?: string;
  user?: { username: string };
};

test("reserved handles can sign in but cannot be newly claimed", async (t) => {
  const password = "test-only-password-123";
  const now = new Date();
  const database = {
    user: ["yumina", "regular_user"].map((handle) => ({
      id: handle, name: handle, username: handle, displayUsername: handle,
      email: `${handle}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })),
    account: await Promise.all(["yumina", "regular_user"].map(async (handle) => ({
      id: handle, userId: handle, accountId: handle, providerId: "credential",
      password: await hashPassword(password), createdAt: now, updatedAt: now,
    }))),
    session: [], verification: [],
  };
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-only-username-auth-secret-at-least-32-characters",
    database: memoryAdapter(database),
    emailAndPassword: { enabled: true },
    plugins: [usernameAuthPlugin()],
    rateLimit: { enabled: false },
    logger: { level: "error" },
  });
  const request = (path: string, body: Record<string, unknown>, cookie = "") => auth.handler(new Request(
    `http://localhost:3000/api/auth${path}`,
    { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie }, body: JSON.stringify(body) },
  ));

  for (const handle of ["Yumina", "yumina", "YUMINA", "regular_user"]) {
    await t.test(`existing ${handle} signs in`, async () => {
      const response = await request("/sign-in/username", { username: handle, password });
      const result = await readAuthResponse(response);
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.user?.username, handle.toLowerCase());
      assert.ok(result.token);
    });
  }

  await t.test("reserved handle still requires its password", async () => {
    const response = await request("/sign-in/username", { username: "Yumina", password: "incorrect-password" });
    assert.equal(response.status, 401);
    assert.equal((await readAuthResponse(response)).code, "INVALID_USERNAME_OR_PASSWORD");
  });

  await t.test("invalid characters are still rejected on login", async () => {
    const response = await request("/sign-in/username", { username: "invalid name", password });
    assert.equal(response.status, 422);
    assert.equal((await readAuthResponse(response)).code, "INVALID_USERNAME");
  });

  await t.test("unclaimed reserved handle cannot be registered", async () => {
    const response = await request("/sign-up/email", { username: "AdMiN", name: "Test", email: "new@example.test", password });
    assert.equal(response.status, 400);
    assert.equal((await readAuthResponse(response)).code, "INVALID_USERNAME");
    assert.equal(database.user.length, 2);
  });

  await t.test("displayUsername fallback cannot register a reserved handle", async () => {
    const response = await request("/sign-up/email", { displayUsername: "AdMiN", name: "Test", email: "fallback@example.test", password });
    assert.equal(response.status, 400);
    assert.equal((await readAuthResponse(response)).code, "INVALID_USERNAME");
    assert.equal(database.user.length, 2);
  });

  await t.test("reserved handle is never offered as available", async () => {
    const response = await request("/is-username-available", { username: "AdMiN" });
    assert.equal(response.status, 422);
    assert.equal((await readAuthResponse(response)).code, "INVALID_USERNAME");
    const ordinary = await request("/is-username-available", { username: "new_user" });
    assert.deepEqual(await ordinary.json(), { available: true });
  });

  await t.test("existing user cannot rename to a reserved handle", async () => {
    const login = await request("/sign-in/username", { username: "regular_user", password });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const response = await request("/update-user", { username: "AdMiN" }, cookie);
    assert.equal(response.status, 400);
    assert.equal((await readAuthResponse(response)).code, "INVALID_USERNAME");
    assert.equal(database.user.find((user) => user.id === "regular_user")?.username, "regular_user");
  });

  await t.test("displayUsername fallback cannot rename to a reserved handle", async () => {
    const login = await request("/sign-in/username", { username: "regular_user", password });
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const response = await request("/update-user", { displayUsername: "AdMiN" }, cookie);
    assert.equal(response.status, 400);
    assert.equal((await readAuthResponse(response)).code, "INVALID_USERNAME");
    assert.equal(database.user.find((user) => user.id === "regular_user")?.username, "regular_user");
  });

  await t.test("official account can edit its profile without changing its handle", async () => {
    const login = await request("/sign-in/username", { username: "Yumina", password });
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const response = await request("/update-user", { name: "Official account" }, cookie);
    assert.equal(response.status, 200);
    assert.equal(database.user.find((user) => user.id === "yumina")?.username, "yumina");
  });

  await t.test("ordinary handles can still be registered and renamed", async () => {
    const signup = await request("/sign-up/email", { username: "new_user", name: "Test", email: "ordinary@example.test", password });
    assert.equal(signup.status, 200, JSON.stringify(await signup.json()));
    const cookie = signup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const update = await request("/update-user", { username: "renamed_user" }, cookie);
    assert.equal(update.status, 200);
    assert.ok(database.user.some((user) => user.username === "renamed_user"));
  });
});
