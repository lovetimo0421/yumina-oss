import { useTranslation } from "react-i18next";
import { DEFAULT_INVITE_RACE_RULES, inviteRaceUsageTickets, type InviteRaceRules } from "@yumina/shared";

/**
 * The rules as a picture: three steps, the ticket ladder, and how the pool is
 * split. Shared by the race page and the launch popup so they never disagree.
 */

/**
 * How tickets work, as three cards a first-time visitor reads in seconds:
 * the ticket count with its unit, and what the friend has to do. The third
 * card adds the one sentence about mushies and three concrete examples.
 */
export function HowItWorksSteps({ rules = DEFAULT_INVITE_RACE_RULES, compact = false }: { rules?: InviteRaceRules; compact?: boolean }) {
  const { t } = useTranslation("profile");
  const firstFree = rules.bands[0]?.from ?? 1000;
  const top = rules.bands.at(-1)?.to ?? 15000;
  const usageMax = inviteRaceUsageTickets(top, rules.bands);
  const perLow = Math.min(...rules.bands.map((b) => b.per));
  const perHigh = Math.max(...rules.bands.map((b) => b.per));
  const examples = [2000, 5000, top].map((m) => ({ m, n: inviteRaceUsageTickets(m, rules.bands) }));
  const card = "flex flex-col rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4";
  const value = (n: number, prefix?: string) => (
    <span className="flex items-baseline gap-1.5">
      {prefix && <span className="text-xs font-bold text-sub/60">{prefix}</span>}
      <span className="text-[30px] font-black leading-none tabular-nums text-gold">+{n}</span>
      <span className="text-sm font-bold text-gold/80">{t("inviteRace.how.unit")}</span>
    </span>
  );
  return (
    <div>
      <div className={compact ? "grid grid-cols-3 gap-2" : "grid gap-3 sm:grid-cols-[1fr_1fr_1.5fr]"}>
        <div className={card}>
          {value(rules.signupTickets)}
          <span className="mt-2.5 text-[13.5px] font-bold text-main">{t("inviteRace.how.s1")}</span>
        </div>
        <div className={card}>
          {value(rules.activeTickets)}
          <span className="mt-2.5 text-[13.5px] font-bold text-main">{t("inviteRace.how.s2")}</span>
        </div>
        <div className={card}>
          {value(usageMax, t("inviteRace.how.upToLabel"))}
          <span className="mt-2.5 text-[13.5px] font-bold text-main">{t("inviteRace.how.s3")}</span>
          {!compact && (
            <>
              <span className="mt-1 text-xs leading-relaxed text-sub/65">
                {t("inviteRace.how.s3b", { days: rules.windowDays, free: firstFree.toLocaleString(), low: perLow, high: perHigh })}
              </span>
              <span className="mt-2.5 grid grid-cols-3 gap-1.5">
                {examples.map((e) => (
                  <span key={e.m} className="flex flex-col items-center rounded-lg bg-black/25 px-1 py-1.5">
                    <span className="text-[10.5px] tabular-nums text-sub/55">{t("inviteRace.how.exShort", { m: e.m.toLocaleString() })}</span>
                    <span className="text-[13px] font-black tabular-nums text-gold">+{e.n} {t("inviteRace.how.unit")}</span>
                  </span>
                ))}
              </span>
            </>
          )}
        </div>
      </div>
      {!compact && (
        <p className="mt-3 text-center text-[12.5px] text-sub/70">
          {t("inviteRace.how.formulaLine", { max: rules.signupTickets + rules.activeTickets + usageMax })}
        </p>
      )}
    </div>
  );
}

/** $1,000 as one strip: the five rank prizes, then the shared pot. */
export function PrizeSplit({ rules = DEFAULT_INVITE_RACE_RULES }: { rules?: InviteRaceRules }) {
  const { t } = useTranslation("profile");
  const ranks = rules.rankPrizesUsd;
  const total = ranks.reduce((a, b) => a + b, 0) + rules.sharedPotUsd;
  return (
    <div>
      <div className="flex h-10 overflow-hidden rounded-xl text-[11px] font-bold">
        {ranks.map((p, i) => (
          <div key={i} className="flex items-center justify-center border-r border-black/25 text-black"
            style={{ flex: p / total, background: ["#e2c27f", "#d6b673", "#c9a25e", "#b8914f", "#a88243"][i] }}>
            {i < 3 ? `#${i + 1}` : ""}
          </div>
        ))}
        <div className="flex items-center justify-center bg-white/[0.08] px-2 text-main" style={{ flex: rules.sharedPotUsd / total }}>
          {t("inviteRace.how.pot", { pot: `$${rules.sharedPotUsd}` })}
        </div>
      </div>
      <p className="mt-2 text-xs text-sub/60">
        {t("inviteRace.how.split", { ranks: ranks.map((p) => `$${p}`).join(" / "), pot: `$${rules.sharedPotUsd}` })}
      </p>
    </div>
  );
}

/**
 * The full rules, grouped the way people look things up: who can join, how
 * tickets count, how the money is split, how it is paid, when it is final,
 * what gets removed, and the event terms. Numbers come from the live rules so
 * the text can never disagree with the payout.
 */
export function RulesList({ rules = DEFAULT_INVITE_RACE_RULES }: { rules?: InviteRaceRules }) {
  const { t } = useTranslation("profile");
  const rate = (rules.mushiesPerUsd ?? 1000).toLocaleString();
  const vars = {
    cap: rules.signupCapPerRound,
    days: rules.windowDays,
    ranks: rules.rankPrizesUsd.map((p) => `$${p}`).join(" / "),
    min: rules.rankMinTickets,
    pot: `$${rules.sharedPotUsd}`,
    cash: `$${rules.cashThresholdUsd}`,
    rate,
    choose: rules.chooseDays,
    max: rules.signupTickets + rules.activeTickets + rules.bands.reduce((s, b) => s + Math.floor((b.to - b.from) / b.per), 0),
  };
  const sections: { title: string; items: string[] }[] = [
    { title: t("inviteRace.full.whoTitle"), items: [t("inviteRace.full.who1"), t("inviteRace.full.who2"), t("inviteRace.full.who3")] },
    {
      title: t("inviteRace.full.ticketsTitle"),
      items: [
        t("inviteRace.full.t1", vars),
        t("inviteRace.full.t2", vars),
        t("inviteRace.full.t3", vars),
        ...rules.bands.map((b) => t("inviteRace.rBand", { from: b.from.toLocaleString(), to: b.to.toLocaleString(), per: b.per, n: Math.floor((b.to - b.from) / b.per) })),
        t("inviteRace.full.t4", vars),
        t("inviteRace.full.t5", vars),
      ],
    },
    { title: t("inviteRace.full.splitTitle"), items: [t("inviteRace.full.s1", vars), t("inviteRace.full.s2", vars), t("inviteRace.full.s3", vars)] },
    { title: t("inviteRace.full.payTitle"), items: [t("inviteRace.full.p1", vars), t("inviteRace.full.p2", vars), t("inviteRace.full.p3", vars), t("inviteRace.full.p4", vars), t("inviteRace.full.p5", vars)] },
    { title: t("inviteRace.full.whenTitle"), items: [t("inviteRace.full.w1", vars), t("inviteRace.full.w2", vars)] },
    { title: t("inviteRace.full.fairTitle"), items: [t("inviteRace.full.f1"), t("inviteRace.full.f2"), t("inviteRace.full.f3")] },
    { title: t("inviteRace.full.termsTitle"), items: [t("inviteRace.full.x1"), t("inviteRace.full.x2"), t("inviteRace.full.x3")] },
  ];
  return (
    <div className="flex flex-col gap-4">
      {sections.map((sec) => (
        <div key={sec.title}>
          <p className="text-[12.5px] font-bold text-main">{sec.title}</p>
          <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[12.5px] leading-relaxed text-sub/75">
            {sec.items.map((it, i) => <li key={i}>{it}</li>)}
          </ul>
        </div>
      ))}
    </div>
  );
}
