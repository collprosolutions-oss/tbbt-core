import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Brain,
  Briefcase,
  CalendarDays,
  CircleCheck,
  CirclePlus,
  CircleX,
  Clock3,
  FileText,
  Globe,
  Handshake,
  HardDrive,
  Headphones,
  LayoutGrid,
  ListTodo,
  Mail,
  MapPinned,
  Megaphone,
  MessageSquare,
  Puzzle,
  ShieldCheck,
  Store,
  UserPlus,
  Users,
  Zap,
} from "lucide-react";
import { TbbtWatchVideoButton } from "@/components/tbbt-marketing/watch-video";
import "@/components/tbbt-marketing/tbbt-pricing.css";
import { getPricingPageProjection } from "@/lib/product-catalog";
import {
  TBBT_FOUNDER_PRICE_LABEL,
  TBBT_FOUNDER_PROTECTION,
  TBBT_HERO_OFFER,
  TBBT_PRICING_PAGE_CTA_BUTTON,
  TBBT_PRICING_PAGE_CTA_HEADLINE,
  TBBT_PRICING_PAGE_CTA_SRC,
  TBBT_PRICING_PAGE_CTA_SUPPORT,
  TBBT_PRICING_PAGE_EYEBROW,
  TBBT_PRICING_PAGE_FOUNDER_CTA,
  TBBT_PRICING_PAGE_HEADLINE,
  TBBT_PRICING_PAGE_HERO_CHECKS,
  TBBT_PRICING_PAGE_HERO_SRC,
  TBBT_PRICING_PAGE_INTRO,
  TBBT_PRICING_PAGE_SCRIPT,
  TBBT_PRICING_PAGE_SUPPORT,
  TBBT_PRICING_PAGE_VALUE_POINTS,
  TBBT_PRICING_TRUST,
  TBBT_SIGN_UP_HREF,
  TBBT_TAGLINE,
} from "@/lib/tbbt-marketing";

const VALUE_ICONS = [Zap, Users, CircleX, Headphones] as const;
const COMPARE_ICONS = [
  LayoutGrid,
  Globe,
  Users,
  CalendarDays,
  FileText,
  Clock3,
  ListTodo,
  Users,
  Megaphone,
  BarChart3,
  Briefcase,
  MapPinned,
  Puzzle,
] as const;
const ADDON_ICONS = {
  trade: Store,
  sms: MessageSquare,
  coach: Brain,
  users: UserPlus,
  storage: HardDrive,
  domain: Mail,
} as const;
const TRUST_ICONS = {
  shield: ShieldCheck,
  handshake: Handshake,
  headset: Headphones,
} as const;

function CompareCell({ value }: { value: string }) {
  if (value === "check") {
    return <CircleCheck size={16} className="tbbt-prc-check" aria-label="Included" />;
  }
  if (value === "dash") {
    return <span className="tbbt-prc-dash" aria-label="Not included">—</span>;
  }
  return <span>{value}</span>;
}

export function TbbtPricingPage() {
  const pricing = getPricingPageProjection();
  const starter = pricing.plans.find((plan) => plan.code === "STARTER");
  const founder = pricing.plans.find((plan) => plan.code === "FOUNDER");
  const business = pricing.plans.find((plan) => plan.code === "BUSINESS");
  const enterprise = pricing.plans.find((plan) => plan.code === "ENTERPRISE");
  const founderName = founder?.headingName ?? "Founder";

  return (
    <div className="tbbt-pricing">
      <section className="tbbt-prc-hero">
        <div className="tbbt-wrap tbbt-prc-hero-inner">
          <div className="tbbt-prc-hero-copy">
            <p className="tbbt-kicker">{TBBT_PRICING_PAGE_EYEBROW}</p>
            <h1>
              {TBBT_PRICING_PAGE_HEADLINE[0]}
              <br />
              {TBBT_PRICING_PAGE_HEADLINE[1].replace("Your Business.", "")}
              <span className="tbbt-prc-accent">Your Business.</span>
            </h1>
            <p className="tbbt-prc-hero-support">
              {TBBT_PRICING_PAGE_SUPPORT[0]}
              <br />
              {TBBT_PRICING_PAGE_SUPPORT[1]}
            </p>
            <div className="tbbt-prc-values">
              {TBBT_PRICING_PAGE_VALUE_POINTS.map((item, index) => {
                const Icon = VALUE_ICONS[index] ?? Zap;
                return (
                  <article className="tbbt-prc-value" key={item.kicker}>
                    <span className="tbbt-prc-value-icon" aria-hidden="true">
                      <Icon size={18} />
                    </span>
                    <div>
                      <strong>{item.kicker}</strong>
                      <span>{item.body}</span>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
          <div className="tbbt-prc-hero-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={TBBT_PRICING_PAGE_HERO_SRC}
              alt="Tradesman from behind wearing a TBBT shirt that reads Build, Manage, Grow"
            />
            <div className="tbbt-prc-hero-aside">
              <p className="tbbt-prc-script">{TBBT_PRICING_PAGE_SCRIPT}</p>
              <ul>
                {TBBT_PRICING_PAGE_HERO_CHECKS.map((item) => (
                  <li key={item}>
                    <CircleCheck size={16} aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="tbbt-prc-plans" aria-label="TBBT plans">
        <div className="tbbt-wrap tbbt-prc-plan-grid">
          <article className="tbbt-prc-intro">
            <h2>
              {TBBT_PRICING_PAGE_INTRO.heading[0]}
              <br />
              {TBBT_PRICING_PAGE_INTRO.heading[1]}
            </h2>
            <p>{TBBT_PRICING_PAGE_INTRO.body}</p>
            <span className="tbbt-prc-rule" aria-hidden="true" />
            <a className="tbbt-prc-compare-link" href="#compare-plans">
              <strong>{TBBT_PRICING_PAGE_INTRO.compare}</strong>
              <span>{TBBT_PRICING_PAGE_INTRO.compareLead}</span>
              <svg className="tbbt-prc-arrow" viewBox="0 0 72 40" aria-hidden="true">
                <path
                  d="M4 8c18 2 40 4 52 18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3.2"
                  strokeLinecap="round"
                />
                <path
                  d="M46 20l12 8-14 2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          </article>

          <article className="tbbt-prc-card">
            <h3>{starter?.headingName ?? "Starter"}</h3>
            <p className="tbbt-prc-sub">{starter?.tagline}</p>
            <span className="tbbt-prc-status">{starter?.statusBadge}</span>
            {starter?.plannedLabel ? <p className="tbbt-prc-planned">{starter.plannedLabel}</p> : null}
            <ul>
              {(starter?.cardFeatures ?? []).map((item) => (
                <li key={item}>
                  <CircleCheck size={15} aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
            <span className="tbbt-btn tbbt-btn--ghost tbbt-prc-soon-btn">{starter?.statusBadge}</span>
          </article>

          <article className="tbbt-prc-card tbbt-prc-card--founder">
            <span className="tbbt-prc-now">{founder?.statusBadge}</span>
            <h3>{founderName}</h3>
            <p className="tbbt-prc-sub">{founder?.tagline}</p>
            <p className="tbbt-prc-price">
              <strong>{founder?.priceAmount ?? "$49"}</strong>
              <span>{founder?.priceSuffix ?? "/month"}</span>
            </p>
            <p className="tbbt-prc-founder-label">{founder?.founderPriceLabel ?? TBBT_FOUNDER_PRICE_LABEL}</p>
            <ul className="tbbt-prc-live-list">
              {(founder?.cardFeatures ?? []).map((item) => (
                <li key={item}>
                  <CircleCheck size={15} aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
            <p className="tbbt-prc-trial">{TBBT_HERO_OFFER}</p>
            <p className="tbbt-prc-protect">{TBBT_FOUNDER_PROTECTION}</p>
            <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary">
              {TBBT_PRICING_PAGE_FOUNDER_CTA}
            </Link>
          </article>

          <article className="tbbt-prc-card">
            <h3>{business?.headingName ?? "Business"}</h3>
            <p className="tbbt-prc-sub">{business?.tagline}</p>
            <span className="tbbt-prc-status">{business?.statusBadge}</span>
            {business?.plannedLabel ? <p className="tbbt-prc-planned">{business.plannedLabel}</p> : null}
            <ul>
              {(business?.cardFeatures ?? []).map((item) => (
                <li key={item}>
                  <CircleCheck size={15} aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
            <span className="tbbt-btn tbbt-btn--ghost tbbt-prc-soon-btn">{business?.statusBadge}</span>
          </article>

          <article className="tbbt-prc-card">
            <h3>{enterprise?.headingName ?? "Enterprise"}</h3>
            <p className="tbbt-prc-sub">{enterprise?.tagline}</p>
            <span className="tbbt-prc-status">{enterprise?.statusBadge}</span>
            {enterprise?.plannedLabel ? <p className="tbbt-prc-planned">{enterprise.plannedLabel}</p> : null}
            <ul>
              {(enterprise?.cardFeatures ?? []).map((item) => (
                <li key={item}>
                  <CircleCheck size={15} aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
            <Link href="/contact" className="tbbt-btn tbbt-btn--ghost tbbt-prc-soon-btn">
              Contact Us
            </Link>
          </article>
        </div>
      </section>

      <section className="tbbt-prc-compare-band" id="compare-plans">
        <div className="tbbt-wrap tbbt-prc-compare-grid">
          <div className="tbbt-prc-table-wrap">
            <table className="tbbt-prc-table">
              <thead>
                <tr>
                  <th>Features</th>
                  <th>
                    {starter?.headingName ?? "Starter"}
                    <span>{starter?.statusBadge}</span>
                  </th>
                  <th>
                    {founderName}
                    <span>{founder?.founderPriceLabel ?? TBBT_FOUNDER_PRICE_LABEL}</span>
                  </th>
                  <th>
                    {business?.headingName ?? "Business"}
                    <span>{business?.statusBadge}</span>
                  </th>
                  <th>
                    {enterprise?.headingName ?? "Enterprise"}
                    <span>{enterprise?.statusBadge}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pricing.compareRows.map((row, index) => {
                  const Icon = COMPARE_ICONS[index] ?? LayoutGrid;
                  return (
                    <tr key={row.label}>
                      <th>
                        <span>
                          <Icon size={15} aria-hidden="true" />
                          {row.label}
                        </span>
                      </th>
                      {row.values.map((value, valueIndex) => (
                        <td key={`${row.label}-${valueIndex}`}>
                          <CompareCell value={value} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <aside className="tbbt-prc-addons">
            <h2>Optional Add-Ons</h2>
            <p>Add more power to your plan anytime.</p>
            <ul>
              {pricing.addons.map((item) => {
                const Icon = ADDON_ICONS[item.icon];
                return (
                  <li key={item.title}>
                    <span className="tbbt-prc-addon-icon" aria-hidden="true">
                      <Icon size={16} />
                    </span>
                    <div>
                      <strong>{item.title}</strong>
                    </div>
                    <div className="tbbt-prc-addon-meta">
                      <em>{item.status}</em>
                      <span>{item.price}</span>
                    </div>
                    <span className="tbbt-prc-addon-plus" aria-hidden="true">
                      <CirclePlus size={18} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </aside>
        </div>
      </section>

      <section className="tbbt-prc-trust" aria-label="Why TBBT pricing">
        <div className="tbbt-wrap tbbt-prc-trust-grid">
          {TBBT_PRICING_TRUST.map((item) => {
            const Icon = TRUST_ICONS[item.icon];
            return (
              <article key={item.title}>
                <span aria-hidden="true">
                  <Icon size={28} />
                </span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="tbbt-prc-cta">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="tbbt-prc-cta-photo" src={TBBT_PRICING_PAGE_CTA_SRC} alt="" />
        <div className="tbbt-wrap tbbt-prc-cta-inner">
          <div className="tbbt-prc-cta-copy">
            <h2>{TBBT_PRICING_PAGE_CTA_HEADLINE}</h2>
            <p>{TBBT_PRICING_PAGE_CTA_SUPPORT}</p>
            <div className="tbbt-hero-actions tbbt-prc-cta-actions">
              <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
                {TBBT_PRICING_PAGE_CTA_BUTTON}
                <ArrowRight size={16} />
              </Link>
              <TbbtWatchVideoButton />
            </div>
          </div>
          <p className="tbbt-prc-cta-script">{TBBT_TAGLINE}</p>
        </div>
      </section>
    </div>
  );
}
