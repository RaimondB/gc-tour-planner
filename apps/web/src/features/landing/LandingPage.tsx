// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { Logo } from "../shell/Logo.js";
import { analyticsEnabled } from "../../lib/cloudflare-analytics.js";

const REPO_URL = "https://github.com/RaimondB/gc-tour-planner";

/**
 * Prefilled "request a region" GitHub issue. We open new regions based on
 * demand, so interest is tallied from the issue count + 👍 reactions.
 */
const REGION_REQUEST_URL = `${REPO_URL}/issues/new?${new URLSearchParams({
  title: "Region request: <your area>",
  labels: "region-request",
  body: [
    "Which area would you like gc-tour-planner to cover?",
    "",
    "- Region / country:",
    "- Roughly how often would you use it (and how many caches?):",
    "",
    "We open new regions based on demand — thanks for the nudge! 👍 this issue (or an existing one) to add weight.",
  ].join("\n"),
}).toString()}`;

/** One of the three "how it works" steps, mirroring the in-app JourneyRail. */
interface Step {
  readonly n: number;
  readonly title: string;
  readonly body: string;
  readonly img: string;
  readonly alt: string;
}

const STEPS: readonly Step[] = [
  {
    n: 1,
    title: "Find caches",
    body: "Upload your Pocket Query or GPX, then filter by cache type, attributes, and surroundings — prefer forest and parks over urban filler.",
    img: "/landing/step-1-find.webp",
    alt: "The planner showing geocaches on the map with the Find caches filter controls.",
  },
  {
    n: 2,
    title: "Pick a cluster",
    body: "The planner discovers dense clusters of caches that fit a walking-loop distance and time budget, and ranks the best candidates for you.",
    img: "/landing/step-2-cluster.webp",
    alt: "Discovered cache clusters previewed on the map, ready to choose from.",
  },
  {
    n: 3,
    title: "Plan & export",
    body: "Get an optimised closed loop that starts and finishes at a sensible parking spot, with a score breakdown — then save it or export GPX for the field.",
    img: "/landing/step-3-plan.webp",
    alt: "A planned closed walking loop with a parking marker and route on the map.",
  },
];

/**
 * A shipped capability worth advertising. KEEP IN SYNC with what the app
 * actually does: when a PR changes what users can do, update this list in the
 * same PR (docs-policy.md / PR checklist / CLAUDE.md "marketing page parity").
 */
const FEATURES: readonly { title: string; body: string }[] = [
  {
    title: "GPX import, kept private",
    body: "Bring your own Groundspeak Pocket Queries. Uploaded caches are isolated per user — visible only to you.",
  },
  {
    title: "Type & attribute filters",
    body: "Hard-filter by cache type and Groundspeak attributes (dog-allowed, needs special tool, and more).",
  },
  {
    title: "Surroundings-aware scoring",
    body: "Soft preferences scored against OpenStreetMap landuse — favour forest and parks, avoid residential filler.",
  },
  {
    title: "Cluster discovery",
    body: "Automatically detects dense clusters of caches that admit a closed walking loop within your budget.",
  },
  {
    title: "Parking-aware loops",
    body: "Frames each loop around real parking — GPX parking waypoints, OSM parking facilities, or the nearest routable road.",
  },
  {
    title: "Saved tours & Google sign-in",
    body: "Create an account or sign in with Google, then save your planned tours and pick up where you left off.",
  },
];

/**
 * Public `/welcome` route — the marketing landing page shown to anonymous
 * visitors (the `/` planner bounces here when signed out). No auth required.
 */
export function LandingPage(): JSX.Element {
  return (
    <div className="landing">
      <header className="landing__topbar">
        <span className="landing__brand">
          <Logo size={30} />
          gc-tour-planner
        </span>
        <nav className="landing__nav">
          <Link to="/login" className="landing__signin">
            Sign in
          </Link>
          <Link to="/register" className="landing__cta">
            Create account
          </Link>
        </nav>
      </header>

      <main>
        <section className="landing__hero">
          <Logo size={72} />
          <h1 className="landing__hero-title">
            Plan closed-loop geocaching tours from filtered cache clusters
          </h1>
          <p className="landing__hero-lede">
            Pick a starting point and radius, filter caches by type, attributes,
            and surroundings, find a dense cluster, and get a closed walking
            loop that starts and ends at a parking spot.
          </p>
          <div className="landing__hero-actions">
            <Link to="/register" className="landing__cta landing__cta--lg">
              Create account
            </Link>
            <Link to="/login" className="landing__signin landing__signin--lg">
              Sign in
            </Link>
          </div>
          <p className="landing__coverage-note">
            Currently covering the <strong>Netherlands</strong> and{" "}
            <strong>NRW</strong> (Germany).{" "}
            <a href={REGION_REQUEST_URL} target="_blank" rel="noreferrer">
              Want another region?
            </a>
          </p>
        </section>

        <section className="landing__section" aria-labelledby="how-heading">
          <h2 id="how-heading" className="landing__section-title">
            How it works
          </h2>
          <ol className="landing__steps">
            {STEPS.map((step) => (
              <li key={step.n} className="landing__step">
                <img
                  className="landing__step-shot"
                  src={step.img}
                  alt={step.alt}
                  loading="lazy"
                  width={640}
                  height={400}
                />
                <div className="landing__step-text">
                  <span className="landing__step-num">{step.n}</span>
                  <h3 className="landing__step-title">{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section
          className="landing__section landing__everywhere"
          aria-labelledby="everywhere-heading"
        >
          <div className="landing__everywhere-text">
            <h2 id="everywhere-heading" className="landing__section-title">
              Works on mobile and desktop
            </h2>
            <p>
              The same planner adapts to your screen: a docked control panel on
              the desktop, a draggable bottom sheet on your phone. Plan at home,
              then take it into the field.
            </p>
          </div>
          <img
            className="landing__everywhere-shot"
            src="/landing/responsive.webp"
            alt="The planner shown side by side in a desktop browser and on a phone."
            loading="lazy"
            width={760}
            height={420}
          />
        </section>

        <section
          className="landing__section"
          aria-labelledby="features-heading"
        >
          <h2 id="features-heading" className="landing__section-title">
            What you get
          </h2>
          <ul className="landing__features">
            {FEATURES.map((f) => (
              <li key={f.title} className="landing__feature">
                <h3 className="landing__feature-title">{f.title}</h3>
                <p>{f.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section
          className="landing__section landing__coverage"
          aria-labelledby="coverage-heading"
        >
          <h2 id="coverage-heading" className="landing__section-title">
            Where it works today
          </h2>
          <p className="landing__coverage-text">
            Right now the planner covers the <strong>Netherlands</strong> and{" "}
            <strong>North Rhine-Westphalia (NRW)</strong> in Germany — the
            regions whose OpenStreetMap map and walking-route data we currently
            host.
          </p>
          <p className="landing__coverage-text">
            Want your part of the world supported? Let us know — we open up new
            regions based on how much interest there is.
          </p>
          <a
            className="landing__btn-outline"
            href={REGION_REQUEST_URL}
            target="_blank"
            rel="noreferrer"
          >
            Request a region
          </a>
        </section>

        <section className="landing__finalcta">
          <h2 className="landing__section-title">
            Ready to plan your next tour?
          </h2>
          <Link to="/register" className="landing__cta landing__cta--lg">
            Create account
          </Link>
        </section>
      </main>

      <footer className="landing__footer">
        <p>
          Map data &copy;{" "}
          <a href="https://www.openstreetmap.org/copyright">
            OpenStreetMap contributors
          </a>
          . Open source under{" "}
          <a href={`${REPO_URL}/blob/main/LICENSE`}>GPL-3.0-or-later</a> —{" "}
          <a href={REPO_URL}>source on GitHub</a>.
        </p>
        <p className="landing__footer-note">
          Built on OpenStreetMap data. Bring your own Pocket Query — geocache
          data is never redistributed.
        </p>
        {analyticsEnabled && (
          <p className="landing__footer-note">
            Privacy-friendly, cookieless analytics via{" "}
            <a href="https://www.cloudflare.com/web-analytics/">Cloudflare</a>.
          </p>
        )}
      </footer>
    </div>
  );
}
