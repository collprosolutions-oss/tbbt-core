import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Building2,
  CalendarClock,
  Camera,
  CircleDollarSign,
  ClipboardList,
  CreditCard,
  Download,
  FileText,
  Globe,
  Hammer,
  Inbox,
  KeyRound,
  MapPinned,
  Megaphone,
  MessageSquare,
  Notebook,
  Plug,
  Receipt,
  Ruler,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Timer,
  UserCog,
  Users,
  Wrench,
} from "lucide-react";
import { TbbtWatchVideoButton } from "@/components/tbbt-marketing/watch-video";
import "@/components/tbbt-marketing/tbbt-features.css";
import {
  TBBT_ADDITIONAL_FEATURES,
  TBBT_BRAND_MOTTO,
  TBBT_COMING_BADGE_LABEL,
  TBBT_COMING_FEATURES,
  TBBT_CORE_FEATURES,
  TBBT_FEATURES_HERO_EYEBROW,
  TBBT_FEATURES_HERO_HEADLINE,
  TBBT_FEATURES_HERO_SUPPORT,
  TBBT_FEATURES_VALUE_POINTS,
  TBBT_HERO_OFFER,
  TBBT_SIGN_UP_HREF,
  TBBT_TAGLINE,
  TBBT_TRIAL_CTA_LABEL,
} from "@/lib/tbbt-marketing";

const VALUE_ICONS = [Timer, Sparkles, ShieldCheck, Hammer] as const;

const CORE_ICONS = {
  website: Globe,
  crm: Users,
  schedule: CalendarClock,
  estimate: FileText,
  jobs: Hammer,
  invoice: CreditCard,
  time: Timer,
  team: UserCog,
  marketing: ClipboardList,
  reports: BarChart3,
} as const;

const EXTRA_ICONS = [
  Wrench,
  Camera,
  BookOpen,
  Inbox,
  Settings,
  CircleDollarSign,
  Receipt,
  Star,
  Notebook,
  Ruler,
  MessageSquare,
] as const;

const COMING_ICONS = [
  KeyRound,
  Building2,
  MapPinned,
  Plug,
  Megaphone,
  Download,
  Sparkles,
] as const;

const CORE_UI_SHOTS: Partial<
  Record<(typeof TBBT_CORE_FEATURES)[number]["visual"], string>
> = {
  website: "/brand/tbbt-marketing/feat-core-website.png",
  crm: "/brand/tbbt-marketing/feat-core-crm.png",
  schedule: "/brand/tbbt-marketing/feat-core-schedule.png",
  estimate: "/brand/tbbt-marketing/feat-core-estimates.png",
  jobs: "/brand/tbbt-marketing/feat-core-jobs.png",
  invoice: "/brand/tbbt-marketing/feat-core-invoices.png",
  time: "/brand/tbbt-marketing/feat-core-time.png",
  team: "/brand/tbbt-marketing/feat-core-team.png",
  marketing: "/brand/tbbt-marketing/feat-core-marketing.png",
  reports: "/brand/tbbt-marketing/feat-core-reports.png",
};

function FeatureVisual({
  visual,
}: {
  visual: (typeof TBBT_CORE_FEATURES)[number]["visual"];
}) {
  const src = CORE_UI_SHOTS[visual];

  if (src) {
    return (
      <div className="tbbt-feat-shot">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" />
      </div>
    );
  }

  const Icon = CORE_ICONS[visual];
  return (
    <div className="tbbt-feat-graphic" aria-hidden="true">
      <span className="tbbt-feat-graphic-icon">
        <Icon size={34} />
      </span>
    </div>
  );
}

export function TbbtFeaturesPage() {
  return (
    <div className="tbbt-features">
      <section className="tbbt-feat-hero">
        <div className="tbbt-wrap tbbt-feat-hero-inner">
          <div className="tbbt-feat-hero-copy">
            <p className="tbbt-kicker">{TBBT_FEATURES_HERO_EYEBROW}</p>
            <h1>
              {TBBT_FEATURES_HERO_HEADLINE[0]}
              <br />
              <span className="tbbt-feat-hero-accent">{TBBT_FEATURES_HERO_HEADLINE[1]}</span>
            </h1>
            <p className="tbbt-feat-hero-support">{TBBT_FEATURES_HERO_SUPPORT}</p>
            <div className="tbbt-hero-actions">
              <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
                {TBBT_TRIAL_CTA_LABEL}
                <ArrowRight size={16} />
              </Link>
              <Link href="#core-features" className="tbbt-btn tbbt-btn--ghost tbbt-btn--lg">
                See Core Features
              </Link>
            </div>
          </div>
          <div className="tbbt-feat-hero-visual">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/tbbt-marketing/hero-devices.png"
              alt="TBBT workspace on desktop and phone"
            />
          </div>
        </div>
        <div className="tbbt-wrap tbbt-feat-values">
          {TBBT_FEATURES_VALUE_POINTS.map((item, index) => {
            const Icon = VALUE_ICONS[index] ?? Sparkles;
            return (
              <article className="tbbt-feat-value" key={item.kicker}>
                <Icon size={18} />
                <div>
                  <strong>{item.kicker}</strong>
                  <p>{item.body}</p>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="tbbt-feat-core" id="core-features">
        <div className="tbbt-wrap">
          <div className="tbbt-feat-core-head">
            <h2>Core Features</h2>
            <p className="tbbt-muted">
              The operating tools in TBBT today — not a pile of separate apps.
            </p>
          </div>
          <div className="tbbt-feat-core-grid">
            {TBBT_CORE_FEATURES.map((feature) => {
              const Icon = CORE_ICONS[feature.visual];
              return (
                <article
                  key={feature.id}
                  id={feature.id}
                  className="tbbt-feat-card"
                >
                  <div className="tbbt-feat-card-top">
                    <span className="tbbt-feat-card-icon">
                      <Icon size={16} />
                    </span>
                    <h3>{feature.title}</h3>
                  </div>
                  <FeatureVisual visual={feature.visual} />
                  <p className="tbbt-muted">{feature.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="tbbt-feat-extra">
        <div className="tbbt-wrap">
          <div className="tbbt-feat-core-head">
            <h2>Additional Features</h2>
            <p className="tbbt-muted">More of the workspace, labeled honestly.</p>
          </div>
          <div className="tbbt-feat-extra-grid">
            {TBBT_ADDITIONAL_FEATURES.map((feature, index) => {
              const Icon = EXTRA_ICONS[index] ?? Sparkles;
              return (
                <article className="tbbt-feat-extra-card" key={feature.title}>
                  <span className="tbbt-feat-card-icon">
                    <Icon size={16} />
                  </span>
                  <div>
                    <h3>{feature.title}</h3>
                    <p className="tbbt-muted">{feature.body}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="tbbt-feat-coming" id="coming-to-tbbt">
        <div className="tbbt-wrap">
          <div className="tbbt-feat-core-head">
            <h2>Coming to TBBT</h2>
            <p className="tbbt-muted">
              Roadmap directions — not live in the workspace today.
            </p>
          </div>
          <div className="tbbt-feat-coming-grid">
            {TBBT_COMING_FEATURES.map((feature, index) => {
              const Icon = COMING_ICONS[index] ?? Sparkles;
              return (
                <article className="tbbt-feat-coming-card" key={feature.title}>
                  <span className="tbbt-feat-card-icon">
                    <Icon size={16} />
                  </span>
                  <div>
                    <h3>
                      {feature.title}
                      <span
                        className={
                          feature.badge === "coming-soon"
                            ? "tbbt-badge tbbt-badge--coming"
                            : "tbbt-badge"
                        }
                      >
                        {TBBT_COMING_BADGE_LABEL[feature.badge]}
                      </span>
                    </h3>
                    <p className="tbbt-muted">{feature.body}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="tbbt-feat-cta">
        <div className="tbbt-wrap tbbt-feat-cta-inner">
          <div>
            <h2>Ready to Run Your Business From One Place?</h2>
            <p className="tbbt-muted tbbt-feat-cta-lead">{TBBT_HERO_OFFER}</p>
            <div className="tbbt-hero-actions tbbt-feat-cta-actions">
              <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
                {TBBT_TRIAL_CTA_LABEL}
                <ArrowRight size={16} />
              </Link>
              <TbbtWatchVideoButton />
            </div>
          </div>
          <div className="tbbt-feat-cta-motto">
            <p className="tbbt-script">{TBBT_BRAND_MOTTO}</p>
            <p>{TBBT_TAGLINE}</p>
          </div>
        </div>
      </section>
    </div>
  );
}
