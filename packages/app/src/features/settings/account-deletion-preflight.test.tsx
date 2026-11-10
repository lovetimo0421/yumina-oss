import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import zh from "../../locales/zh/settings.json";
import { DeletionPreflightNotice, deletionErrorMessage, type DeletionPreflight } from "./account-deletion-preflight";

const i18n = createInstance();
await i18n.init({ lng: "zh", resources: { zh: { settings: zh } }, defaultNS: "settings", interpolation: { escapeValue: false } });
const render = (report: DeletionPreflight | null, failed = false) => renderToStaticMarkup(
  <I18nextProvider i18n={i18n}><DeletionPreflightNotice report={report} failed={failed} retry={() => {}} /></I18nextProvider>,
);

test("notice displays every blocker and the safe email-only distinction", () => {
  const html = render({ canSendEmail: true, canDelete: false, issues: [
    { code: "BILLING_CLEANUP_UNAVAILABLE", blocksEmail: false, billingRecords: ["customer", "connect"] },
  ] });
  assert.ok(html.includes("尚未配置支付清理功能"));
  assert.ok(html.includes("支付客户记录 / 创作者收款记录"));
  assert.ok(html.includes("仍可接收确认邮件"));
  assert.ok(!html.includes("无法安全取消你的订阅"));
  const multiple = render({ canSendEmail: false, canDelete: false, issues: [
    { code: "LAST_ADMIN_ACCOUNT", blocksEmail: true },
    { code: "PENDING_CREATOR_EARNINGS", blocksEmail: true },
  ] });
  assert.ok(multiple.includes("最后一个管理员"));
  assert.ok(multiple.includes("创作者收入等待结算"));
  assert.ok(multiple.includes("请先处理以上问题"));
});

test("loading, unavailable and clean diagnostics have distinct recoverable states", () => {
  assert.ok(render(null).includes("正在检查"));
  assert.ok(render(null, true).includes("重新检查"));
  assert.equal(render({ issues: [], canSendEmail: true, canDelete: true }), "");
});

test("billing failure categories and cooldown are not collapsed into a generic subscription error", () => {
  const t = i18n.getFixedT("zh", "settings");
  const codes = ["BILLING_CLEANUP_UNAVAILABLE", "SUBSCRIPTION_LOOKUP_FAILED", "SUBSCRIPTION_CANCELLATION_FAILED", "PAYMENT_SETTLEMENT_PENDING"];
  assert.equal(new Set(codes.map(code => deletionErrorMessage(t, code))).size, 4);
  assert.ok(deletionErrorMessage(t, "ACCOUNT_DELETION_COOLDOWN", "2026-10-19T00:00:00Z").includes("2026"));
  assert.equal(deletionErrorMessage(t, "ACCOUNT_DELETION_COOLDOWN", "invalid"), t("account.deleteAccount.errors.cooldown"));
  assert.equal(deletionErrorMessage(t, "unknown"), t("account.deleteAccount.errors.generic"));
});
