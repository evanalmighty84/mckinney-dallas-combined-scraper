#!/usr/bin/env node

"use strict";

require("dotenv").config();

const { randomUUID } = require("crypto");
const { chromium } = require("playwright-core");
const pool = require("./db/db");
const normalizeCity = require("./normalizeCity");

const TABLE_NAME =
    "unfiltered_ins_mold_pest_housecl_plumb_paint_land_lawn_handy";

// Search-learning audit tables. These do not change which fixed search terms run;
// they only record result quality so terms/categories can be ranked over time.
const SEARCH_RUNS_TABLE = "combined_search_runs";
const SEARCH_RESULTS_TABLE = "combined_search_results";
const SEARCH_TERM_SOURCE = "fixed";

const ENRICHMENT_ENDPOINT_PATH = "/run";

const CRM_API_BASE_URL =
    process.env.CRM_API_BASE_URL ||
    "http://ftn-enrichment.railway.internal:8080";

const NEXTDOOR_QUEUE_API_BASE_URL =
    process.env.NEXTDOOR_QUEUE_API_BASE_URL ||
    "https://crm-function-app-5d4de511071d.herokuapp.com/server/lead_function/api/nextdoor";

const NEXTDOOR_QUEUE_SCRAPER_KEY =
    "combined";

const NEXTDOOR_QUEUE_SCRAPER_NAME =
    "McKinney Dallas Combined Scraper";

const MAX_POSTS_PER_TERM = Number(
    process.env.COMBINATION_MAX_POSTS ||
    process.env.GENERAL_CONTRACTING_MAX_POSTS ||
    50,
);

const TERM_DELAY_MIN_MS = Math.max(
    2_000,
    Number(process.env.COMBINATION_TERM_DELAY_MIN_MS || 5_000),
);

const TERM_DELAY_MAX_MS = Math.max(
    TERM_DELAY_MIN_MS,
    Number(process.env.COMBINATION_TERM_DELAY_MAX_MS || 9_000),
);

const DETAIL_WEIGHT_DELAY_MS = Math.max(
    0,
    Number(process.env.COMBINATION_DETAIL_WEIGHT_DELAY_MS || 1_500),
);

const DETAIL_WEIGHT_DELAY_CAP_MS = Math.max(
    0,
    Number(process.env.COMBINATION_DETAIL_WEIGHT_DELAY_CAP_MS || 12_000),
);
const FALLBACK_STATE =
    process.env.COMBINATION_FALLBACK_STATE ||
    process.env.GENERAL_CONTRACTING_FALLBACK_STATE ||
    "TX";

const SEARCH_TERM_LEAD_TYPES = {
    // Home security / alarms / cameras
    "home security": ["security"],
    "security system": ["security"],
    "security systems": ["security"],
    "security camera": ["security"],
    "security cameras": ["security"],
    "alarm system": ["security"],
    "alarm company": ["security"],
    "burglar alarm": ["security"],
    "home alarm": ["security"],
    "camera installation": ["security"],
    "security camera installation": ["security"],
    "doorbell camera": ["security"],
    "surveillance camera": ["security"],
    "surveillance cameras": ["security"],

    "car insurance": ["insurance"],
    "insurance broker": ["insurance"],
    "State Farm": ["insurance"],
    "Allstate": ["insurance"],



    "mold remediation": ["mold"],
    "mold removal": ["mold"],

    // Pest control
    "pest control": ["pest_control"],
    exterminator: ["pest_control"],
    "wasp nest": ["pest_control"],
    roaches: ["pest_control"],
    rats: ["pest_control"],

    // Plumbing
    plumber: ["plumber"],
    "cast iron": ["plumber"],
    "water leak": ["plumber"],
    "sprinkler repair": ["plumber"],
    "toilet repair": ["plumber"],
    "kitchen sink": ["plumber"],

    // Painting
    painter: ["painter"],
    painting: ["painter"],
    "crown molding": ["painter"],
    "fence stain": ["painter"],
    "deck stain": ["painter"],
    staining: ["painter"],

    // Landscaping
    "tree removal": ["landscaping"],
    "tree trimming": ["landscaping"],
    landscaping: ["landscaping"],
    "yard cleanup": ["landscaping"],
    "bush trimming": ["landscaping"],
    "landscape design": ["landscaping"],

    // Lawn care
    "lawn care": ["lawn_care"],
    "mowing service": ["lawn_care"],

    // Handyman
    handyman: ["handyman"],

    // Flooring / interior
    "hardwood floors": ["interior_designer"],
    flooring: ["interior_designer"],
    "flooring contractor": ["interior_designer"],
    "flooring installer": ["interior_designer"],
    "new flooring": ["interior_designer"],
    "replace flooring": ["interior_designer"],
    "hardwood floor repair": ["interior_designer"],
    "vinyl plank flooring": ["interior_designer"],
    "tile flooring": ["interior_designer"],

    // Home care / senior care
    caregiver: ["home_care"],
    "caregiver needed": ["home_care"],
    "caregiver recommendations": ["home_care"],
    "home care": ["home_care"],
    "senior care": ["home_care"],
    "companion care": ["home_care"],
    "help for my mom": ["home_care"],
    "in home caregiver": ["home_care"],

    // Bookkeeping / QuickBooks / financial visibility

};




const WINDOWS_DOORS_SIDING_SEARCH_TERMS = new Set([
    // WINDOWS — General
    "window",
    "windows",
    "window repair",
    "window replacement",
    "window installation",
    "window installer",
    "new windows",
    "replace windows",
    "broken window",
    "cracked window",
    "window glass",
    "glass replacement",
    "window leak",
    "foggy windows",
    "window screen",
    "window frame",

    // WINDOWS — Blinds & Treatments
    "blinds",
    "new blinds",
    "window blinds",
    "blind installation",
    "blind repair",
    "window shades",
    "window treatments",
    "plantation shutters",

    // DOORS — General
    "door",
    "doors",
    "door repair",
    "door replacement",
    "door installation",
    "door installer",
    "new door",
    "replace door",
    "front door",
    "entry door",
    "exterior door",
    "interior door",
    "patio door",
    "sliding door",
    "french doors",
    "storm door",
    "screen door",
    "door frame",
    "door jamb",
    "door threshold",
    "broken door",
    "door hinges",

    // DOORS — Higher Intent
    "front door replacement",
    "patio door replacement",
    "sliding glass door repair",

    // SIDING — General
    "siding",
    "new siding",
    "siding repair",
    "siding replacement",
    "siding installation",
    "replace siding",
    "vinyl siding",
    "fiber cement siding",
    "hardie board",
    "hardie plank",
    "james hardie",
    "wood siding",
    "damaged siding",
    "rotted siding",
    "siding contractor",
    "siding estimate"
]);


function getLeadTypesForSearchTerm(term) {
    if (SEARCH_TERM_LEAD_TYPES[term]) {
        return SEARCH_TERM_LEAD_TYPES[term];
    }

    const normalized = term.toLowerCase();

    if (!WINDOWS_DOORS_SIDING_SEARCH_TERMS.has(normalized)) {
        return [];
    }

    // Check doors first because "sliding glass door"
    // also contains "glass".
    if (/door|jamb|threshold/i.test(normalized)) {
        return ["doors"];
    }

    if (/siding|hardie/i.test(normalized)) {
        return ["siding"];
    }

    return ["windows"];
}

const SEARCH_TERMS = [
    ...new Set([
        ...Object.keys(SEARCH_TERM_LEAD_TYPES),
        ...WINDOWS_DOORS_SIDING_SEARCH_TERMS
    ])
];

console.log(
    `🔎 Combined scraper configured with ${SEARCH_TERMS.length} search terms`
);



function getSearchDistance(query) {
    const normalizedQuery = String(query || "")
        .trim()
        .toLowerCase();

    return WINDOWS_DOORS_SIDING_SEARCH_TERMS.has(normalizedQuery)
        ? 50
        : 15;
}

function getSearchFilterConfig(query) {
    const normalizedQuery = String(query || "")
        .trim()
        .toLowerCase();

    if (WINDOWS_DOORS_SIDING_SEARCH_TERMS.has(normalizedQuery)) {
        return {
            miles: 50,
            dateLabel: "This Week",
            dateParam: "THIS_WEEK",
        };
    }

    return {
        miles: 15,
        dateLabel: "Today",
        dateParam: "TODAY",
    };
}


const LEAD_TYPES = [
    ...new Set(
        SEARCH_TERMS.flatMap(getLeadTypesForSearchTerm)
    ),
];

console.log(
    `🏷️ Active lead categories: ${LEAD_TYPES.join(", ")}`
);


const SEARCH_PAGE_MAX_ATTEMPTS = Math.max(
    1,
    Number(process.env.SEARCH_PAGE_MAX_ATTEMPTS || 3),
);

const DETAIL_PAGE_MAX_ATTEMPTS = Math.max(
    1,
    Number(process.env.DETAIL_PAGE_MAX_ATTEMPTS || 2),
);

const SEARCH_READY_TIMEOUT_MS = Math.max(
    10_000,
    Number(process.env.SEARCH_READY_TIMEOUT_MS || 25_000),
);

const PAGE_DEFAULT_TIMEOUT_MS = Math.max(
    10_000,
    Number(process.env.PAGE_DEFAULT_TIMEOUT_MS || 30_000),
);

const PAGE_NAVIGATION_TIMEOUT_MS = Math.max(
    20_000,
    Number(process.env.PAGE_NAVIGATION_TIMEOUT_MS || 60_000),
);

const BLOCKED_RESOURCE_TYPES = new Set([
    "image",
    "media",
    "font",
]);

const BLOCKED_REQUEST_URL_PATTERN =
    /(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|2mdn\.net|amazon-adsystem\.com|adnxs\.com|adsystem\.com|simgad)/i;

const IGNORED_PAGE_ERROR_PATTERN =
    /(?:A network error occurred|Failed to load:|Failed to fetch|buildAdSlot is not defined|buildGlaurungAds is not defined|adSlot is not defined|Class extends value undefined|_\.t is not a function)/i;

const TARGET_CRASH_PATTERN =
    /page crashed|target crashed|renderer process crashed/i;

const BROWSER_DISCONNECTED_PATTERN =
    /browser.*disconnected|browser has been closed|connection closed|websocket.*closed/i;

let browserDisconnected = false;
let asynchronousTargetCrashCount = 0;

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

function getErrorMessage(error) {
    return error?.message || String(error || "Unknown error");
}

function isTargetCrashError(error) {
    return TARGET_CRASH_PATTERN.test(getErrorMessage(error));
}

function isBrowserDisconnectedError(error) {
    return BROWSER_DISCONNECTED_PATTERN.test(
        getErrorMessage(error),
    );
}

function isRetryablePageError(error) {
    const message = getErrorMessage(error);

    return (
        isTargetCrashError(error) ||
        /target page, context or browser has been closed/i.test(message) ||
        /navigation failed|net::err_|timeout/i.test(message)
    );
}

function shuffleArray(items) {
    const shuffled = [...items];

    for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));

        [shuffled[i], shuffled[j]] = [
            shuffled[j],
            shuffled[i],
        ];
    }

    return shuffled;
}

function parseNextdoorThrottleMessage(text = "") {
    const match = String(text).match(
        /Throttled,\s*wait\s*(\d+)\s*seconds\.?/i,
    );

    if (!match) return null;

    return {
        waitSeconds: Number(match[1]),
        message: match[0],
    };
}

function isNextdoorThrottleError(error) {
    return /^NEXTDOOR_THROTTLED:/i.test(
        getErrorMessage(error),
    );
}

async function detectNextdoorThrottle(page) {
    const bodyText = await page
        .locator("body")
        .innerText()
        .catch(() => "");

    return parseNextdoorThrottleMessage(bodyText);
}
function nextdoorQueueEndpoint(pathname) {
    return (
        NEXTDOOR_QUEUE_API_BASE_URL.replace(/\/$/, "") +
        pathname
    );
}


async function fetchCarryoverSearchTerms() {
    if (!NEXTDOOR_QUEUE_API_BASE_URL) {
        console.log(
            "ℹ️ Nextdoor queue API is not configured; " +
            "continuing without carryover terms.",
        );

        return [];
    }

    const endpointUrl =
        nextdoorQueueEndpoint(
            `/search-queue/${encodeURIComponent(
                NEXTDOOR_QUEUE_SCRAPER_KEY,
            )}`,
        );

    try {
        console.log(
            `♻️ Loading unfinished combined search terms → ` +
            `${endpointUrl}`,
        );

        const response = await fetch(
            endpointUrl,
            {
                method: "GET",

                headers: {
                    Accept: "application/json",
                },

                signal: AbortSignal.timeout(
                    Math.max(
                        5_000,
                        Number(
                            process.env
                                .NEXTDOOR_QUEUE_TIMEOUT_MS ||
                            20_000,
                        ),
                    ),
                ),
            },
        );

        const responseText =
            await response.text();

        if (!response.ok) {
            throw new Error(
                `Queue GET returned HTTP ` +
                `${response.status}: ` +
                responseText.slice(0, 500),
            );
        }

        const body =
            responseText
                ? JSON.parse(responseText)
                : {};

        const rawTerms =
            Array.isArray(body?.pending_terms)
                ? body.pending_terms
                : [];

        const terms = [];
        const seen = new Set();

        for (const entry of rawTerms) {
            const query = cleanText(
                typeof entry === "string"
                    ? entry
                    : entry?.query ||
                    entry?.search_term ||
                    "",
            );

            const key =
                query.toLowerCase();

            if (
                !query ||
                seen.has(key)
            ) {
                continue;
            }

            seen.add(key);
            terms.push(query);
        }

        console.log(
            `♻️ Loaded ${terms.length} unfinished ` +
            `combined search term(s).`,
        );

        return terms;

    } catch (error) {
        console.warn(
            "⚠️ Could not load combined carryover queue; " +
            "continuing with the normal randomized plan: " +
            getErrorMessage(error),
        );

        return [];
    }
}


async function saveThrottleCarryover({
                                         runId,
                                         throttledTerm,
                                         waitSeconds,
                                         remainingTerms,
                                     }) {
    if (!NEXTDOOR_QUEUE_API_BASE_URL) {
        return false;
    }

    const endpointUrl =
        nextdoorQueueEndpoint(
            "/search-queue/throttled",
        );

    try {
        const response = await fetch(
            endpointUrl,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json",
                },

                body: JSON.stringify({
                    scraper_key:
                    NEXTDOOR_QUEUE_SCRAPER_KEY,

                    scraper_name:
                    NEXTDOOR_QUEUE_SCRAPER_NAME,

                    run_id:
                    runId,

                    throttled_term:
                    throttledTerm,

                    wait_seconds:
                        waitSeconds || null,

                    remaining_terms:
                        remainingTerms.map(
                            (query) => ({
                                query,
                                source: "fixed",
                            }),
                        ),
                }),

                signal: AbortSignal.timeout(
                    Math.max(
                        5_000,
                        Number(
                            process.env
                                .NEXTDOOR_QUEUE_TIMEOUT_MS ||
                            20_000,
                        ),
                    ),
                ),
            },
        );

        const responseText =
            await response.text();

        if (!response.ok) {
            throw new Error(
                `Queue POST returned HTTP ` +
                `${response.status}: ` +
                responseText.slice(0, 500),
            );
        }

        console.log(
            `♻️ Saved ${remainingTerms.length} unfinished ` +
            `combined term(s) to the backend queue.`,
        );

        return true;

    } catch (error) {
        console.error(
            "⚠️ Could not save combined carryover queue " +
            "before exit: " +
            getErrorMessage(error),
        );

        return false;
    }
}


async function clearCarryoverSearchTerms(
    runId,
) {
    if (!NEXTDOOR_QUEUE_API_BASE_URL) {
        return false;
    }

    const endpointUrl =
        nextdoorQueueEndpoint(
            "/search-queue/completed",
        );

    try {
        const response = await fetch(
            endpointUrl,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json",
                },

                body: JSON.stringify({
                    scraper_key:
                    NEXTDOOR_QUEUE_SCRAPER_KEY,

                    run_id:
                    runId,
                }),

                signal: AbortSignal.timeout(
                    Math.max(
                        5_000,
                        Number(
                            process.env
                                .NEXTDOOR_QUEUE_TIMEOUT_MS ||
                            20_000,
                        ),
                    ),
                ),
            },
        );

        const responseText =
            await response.text();

        if (!response.ok) {
            throw new Error(
                `Queue completion POST returned HTTP ` +
                `${response.status}: ` +
                responseText.slice(0, 500),
            );
        }

        console.log(
            "✅ Cleared combined carryover queue " +
            "after full search completion.",
        );

        return true;

    } catch (error) {
        console.warn(
            "⚠️ Could not clear combined carryover queue: " +
            getErrorMessage(error),
        );

        return false;
    }
}

async function configurePage(page, label) {
    page.setDefaultTimeout(PAGE_DEFAULT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(
        PAGE_NAVIGATION_TIMEOUT_MS,
    );

    let suppressedPageErrors = 0;

    page.on("crash", () => {
        console.error(
            `💥 Chromium page crashed (${label}).`,
        );
    });

    page.on("pageerror", (error) => {
        const message = getErrorMessage(error);

        // Nextdoor's ad code emits large bursts of harmless errors when ad
        // images/scripts are blocked. Suppress those so Railway logs remain
        // useful and do not hit the 500-lines-per-second rate limit.
        if (IGNORED_PAGE_ERROR_PATTERN.test(message)) {
            suppressedPageErrors += 1;
            return;
        }

        console.warn(
            `⚠️ Page JavaScript error (${label}): ${message}`,
        );
    });

    page.on("close", () => {
        if (suppressedPageErrors > 0) {
            console.log(
                `ℹ️ Suppressed ${suppressedPageErrors} harmless ` +
                `network/ad page error(s) for ${label}.`,
            );
        }
    });
    page.on("response", (response) => {
        if (response.status() !== 429) {
            return;
        }

        const responseUrl = response.url();

        if (/nextdoor\.com\/search/i.test(responseUrl)) {
            console.error(
                `🌐 HTTP 429 (${label}): ${responseUrl}`,
            );
        }
    });
    await page.route("**/*", async (route) => {
        const request = route.request();
        const resourceType = request.resourceType();
        const requestUrl = request.url();

        if (
            BLOCKED_RESOURCE_TYPES.has(resourceType) ||
            BLOCKED_REQUEST_URL_PATTERN.test(requestUrl)
        ) {
            await route.abort().catch(() => {});
            return;
        }

        await route.continue().catch(() => {});
    });

    return page;
}

async function createConfiguredPage(context, label) {
    const page = await context.newPage();
    return configurePage(page, label);
}

async function closePageSafely(page, label) {
    if (!page || page.isClosed()) {
        return;
    }

    await page.close().catch((error) => {
        console.warn(
            `⚠️ Could not close ${label}: ` +
            getErrorMessage(error),
        );
    });

    // Chromium renderer processes and threads can outlive page.close() for a
    // short time. A slightly longer pause prevents rapid page churn from
    // exhausting Railway's PID/thread allowance.
    await sleep(750);
}

async function closeStaleContextPages(context, keepPage) {
    const stalePages = context
        .pages()
        .filter((page) => page !== keepPage && !page.isClosed());

    if (!stalePages.length) {
        console.log("✅ No stale browser pages needed cleanup.");
        return;
    }

    console.log(
        `🧹 Closing ${stalePages.length} stale page(s) left in the ` +
        `Multilogin profile...`,
    );

    for (let index = 0; index < stalePages.length; index += 1) {
        const stalePage = stalePages[index];

        await stalePage.close().catch((error) => {
            console.warn(
                `⚠️ Could not close stale page ${index + 1}/` +
                `${stalePages.length}: ${getErrorMessage(error)}`,
            );
        });
    }

    // Let Chrome reap the old renderers before disposable pages are created.
    await sleep(2_000);

    console.log(
        `✅ Stale-page cleanup complete. ` +
        `${context.pages().filter((page) => !page.isClosed()).length} ` +
        `page(s) remain open.`,
    );
}

async function parkBootstrapPage(page) {
    if (!page || page.isClosed()) {
        return;
    }

    console.log(
        "🅿️ Parking the bootstrap page on about:blank to release Nextdoor page memory...",
    );

    await page
        .goto("about:blank", {
            waitUntil: "commit",
            timeout: 15_000,
        })
        .catch((error) => {
            console.warn(
                "⚠️ Could not park bootstrap page: " +
                getErrorMessage(error),
            );
        });
}

// Playwright can occasionally surface a renderer crash through an asynchronous
// CDP callback after page.goto() has already rejected. Because every search and
// detail operation below uses a disposable page, it is safe to suppress only
// this exact target-crash exception and continue with a fresh page.
process.on("uncaughtException", (error) => {
    if (isTargetCrashError(error)) {
        asynchronousTargetCrashCount += 1;

        console.error(
            "🧯 Captured asynchronous Playwright Target crashed error. " +
            "The current disposable page will be replaced.",
        );
        return;
    }

    console.error(
        "❌ Uncaught exception:",
        error?.stack || getErrorMessage(error),
    );
    process.exit(1);
});

function cleanText(value = "") {
    return String(value).replace(/\s+/g, " ").trim();
}

function parseNextdoorPostTimestamp(value, now = new Date()) {
    const raw = cleanText(value);
    if (!raw) return null;

    const lower = raw.toLowerCase();
    const date = new Date(now);

    if (/^today$/i.test(raw)) {
        return date.toISOString();
    }

    if (/^yesterday$/i.test(raw)) {
        date.setDate(date.getDate() - 1);
        return date.toISOString();
    }

    let match = lower.match(/^(\d+)\s*(?:min|mins|minute|minutes)\s*ago$/i);
    if (match) {
        date.setMinutes(date.getMinutes() - Number(match[1]));
        return date.toISOString();
    }

    match = lower.match(/^(\d+)\s*(?:hr|hrs|hour|hours)\s*ago$/i);
    if (match) {
        date.setHours(date.getHours() - Number(match[1]));
        return date.toISOString();
    }

    match = lower.match(/^(\d+)\s*(?:d|day|days)\s*(?:ago)?$/i);
    if (match) {
        date.setDate(date.getDate() - Number(match[1]));
        return date.toISOString();
    }

    match = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(\d{4}))?$/);
    if (match) {
        const day = Number(match[1]);
        const monthName = match[2];
        let year = match[3] ? Number(match[3]) : now.getFullYear();
        let parsed = new Date(
            monthName + " " + day + ", " + year + " 12:00:00"
        );

        if (Number.isNaN(parsed.getTime())) {
            return null;
        }

        if (!match[3] && parsed.getTime() > now.getTime() + 7 * 86400000) {
            year -= 1;
            parsed = new Date(
                monthName + " " + day + ", " + year + " 12:00:00"
            );
        }

        return Number.isNaN(parsed.getTime())
            ? null
            : parsed.toISOString();
    }

    return null;
}

function normalizeDuplicateText(value) {
    return cleanText(value || "")
        .toLowerCase()
        .replace(/[“”"‘’']/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function descriptionsLookLikeSamePost(left, right) {
    const a = normalizeDuplicateText(left);
    const b = normalizeDuplicateText(right);

    if (!a || !b) return false;
    if (a === b) return true;

    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;

    if (shorter.length >= 30 && longer.includes(shorter)) {
        return true;
    }

    const tokensA = new Set(
        a.split(" ").filter((token) => token.length >= 3),
    );
    const tokensB = new Set(
        b.split(" ").filter((token) => token.length >= 3),
    );

    if (!tokensA.size || !tokensB.size) {
        return false;
    }

    let overlap = 0;

    for (const token of tokensA) {
        if (tokensB.has(token)) overlap += 1;
    }

    const smallerTokenCount = Math.min(tokensA.size, tokensB.size);

    return (
        smallerTokenCount >= 5 &&
        overlap / smallerTokenCount >= 0.82
    );
}

function authorsCompatibleForDuplicate(left, right) {
    const a = normalizeDuplicateText(left);
    const b = normalizeDuplicateText(right);

    if (!a || !b) {
        return true;
    }

    return a === b;
}

function isCrossTermDuplicate(seenDuringRun, item) {
    const url = normalizePostUrl(item.url || item.post_url);
    const description =
        item.preview || item.text || item.description || "";

    const priorItems = seenDuringRun.get(url) || [];

    const duplicate = priorItems.some((prior) =>
        authorsCompatibleForDuplicate(prior.author, item.author) &&
        descriptionsLookLikeSamePost(prior.description, description)
    );

    if (duplicate) {
        return true;
    }

    if (priorItems.length > 0) {
        console.warn(
            `⚠️ Same-run reused/mismatched URL not treated as cross-term duplicate: ${url}`,
        );
    }

    priorItems.push({
        author: item.author || null,
        description,
    });

    seenDuringRun.set(url, priorItems);
    return false;
}

function getAdaptiveTermDelayMs(result = {}) {
    const baseRange = Math.max(
        0,
        TERM_DELAY_MAX_MS - TERM_DELAY_MIN_MS,
    );

    const base =
        TERM_DELAY_MIN_MS +
        Math.floor(Math.random() * (baseRange + 1));

    const detailLoad = Math.min(
        DETAIL_WEIGHT_DELAY_CAP_MS,
        Math.max(0, Number(result.newCandidates || 0)) *
            DETAIL_WEIGHT_DELAY_MS,
    );

    return base + detailLoad;
}

function normalizePostUrl(url) {
    try {
        const parsed = new URL(url);
        const postId =
            parsed.pathname.match(/\/(?:p|posting)\/([^/?#]+)/i)?.[1];

        return postId
            ? `https://nextdoor.com/p/${postId}`
            : `${parsed.origin}${parsed.pathname}`;
    } catch {
        return url;
    }
}

function parseExplicitLocation(location = "") {
    const clean = cleanText(location);
    const match = clean.match(/^(.+?),\s*([A-Z]{2})$/);

    return match
        ? {
            city: match[1].trim(),
            state: match[2].trim(),
        }
        : {
            city: clean || null,
            state: null,
        };
}

function guessCity(location = "") {
    const lower = location.toLowerCase();

    const knownCities = [
        "allen",
        "mckinney",
        "plano",
        "frisco",
        "dallas",
        "prosper",
        "little elm",
        "richardson",
        "garland",
        "carrollton",
        "mesquite",
        "arlington",
        "grapevine",
        "sachse",
        "celina",
        "lewisville",
        "desoto",
        "north richland hills",
        "lowry crossing",
        "melissa",
    ];

    const direct = knownCities.find((city) => lower.includes(city));

    if (direct) return direct;
    if (lower.includes("craig ranch")) return "mckinney";
    if (lower.includes("eldorado")) return "mckinney";
    if (lower.includes("trinity falls")) return "mckinney";
    if (lower.includes("stonebridge ranch")) return "mckinney";
    if (lower.includes("westridge")) return "mckinney";
    if (lower.includes("mckinney north")) return "mckinney";

    return null;
}

async function resolveCityState({ location, description }) {
    const explicit = parseExplicitLocation(location);

    let city = explicit.city;
    let state = explicit.state || FALLBACK_STATE;

    const guessed = guessCity(location);
    if (guessed) city = guessed;

    try {
        const normalized = await normalizeCity({
            city,
            state,
            location,
            description,
        });

        return {
            city: normalized?.city || city || null,
            state: normalized?.state || state || null,
        };
    } catch (error) {
        console.warn(
            `⚠️ normalizeCity failed for "${location}": ${error.message}`,
        );

        return {
            city: city || null,
            state: state || null,
        };
    }
}

async function getCurrentNextdoorPage(context) {
    const pages = context.pages().filter((page) => !page.isClosed());

    return (
        pages.find((page) => /nextdoor\.com/i.test(page.url())) ||
        pages[0] ||
        context.newPage()
    );
}

async function findVisibleSearchBox(page) {
    const selectors = [
        'input[aria-label="Search Nextdoor"]',
        'input[placeholder*="Search Nextdoor" i]',
        'input[type="search"]',
        '[data-testid="search-input"] input',
    ];

    for (const selector of selectors) {
        const candidate = page.locator(selector).first();

        if (
            (await candidate.count().catch(() => 0)) &&
            (await candidate.isVisible().catch(() => false))
        ) {
            return candidate;
        }
    }

    return null;
}

async function waitForNextdoorReady(
    context,
    totalMs = 180_000,
) {
    console.log(
        "⏳ Waiting for the Multilogin profile and Nextdoor feed to finish loading...",
    );
    console.log(
        `   Context has ${context.pages().length} page(s) open`,
    );

    const deadline = Date.now() + totalMs;

    let page = null;
    let hydratingStartedAt = null;
    let forcedFeedNavigation = false;
    let forcedReload = false;

    console.log(
        "   Sleeping 7s for Multilogin to stabilize...",
    );

    await sleep(7_000);

    console.log(
        "   Initial sleep done, entering wait loop...",
    );

    while (Date.now() < deadline) {
        const remaining = Math.max(
            0,
            Math.round((deadline - Date.now()) / 1_000),
        );

        console.log(
            `   ⏱ Polling... ${remaining}s remaining`,
        );

        page = await getCurrentNextdoorPage(context);

        if (!page || page.isClosed()) {
            console.log(
                "   No open page found in context yet...",
            );

            await sleep(2_500);
            continue;
        }

        const url = page.url();

        console.log(`   Current page URL: ${url}`);

        const isNextdoor =
            /(^https?:\/\/)?([^/]+\.)?nextdoor\.com/i.test(url);

        if (!isNextdoor) {
            if (!forcedFeedNavigation) {
                forcedFeedNavigation = true;

                console.log(
                    "🧭 Current page is not Nextdoor. Opening a clean Nextdoor feed...",
                );

                await page
                    .goto("https://nextdoor.com/news_feed/", {
                        waitUntil: "domcontentloaded",
                        timeout: 60_000,
                    })
                    .catch((error) => {
                        console.log(
                            `ℹ️ Feed navigation is still settling: ${error.message}`,
                        );
                    });

                await sleep(5_000);
                continue;
            }

            console.log(
                `   Non-Nextdoor page still open: ${url}`,
            );

            await sleep(2_500);
            continue;
        }

        const searchBox = await findVisibleSearchBox(page);

        if (searchBox) {
            console.log(`✅ Nextdoor is ready: ${url}`);
            return page;
        }

        const isLoginOrInterstitial =
            /\/(login|verify|choose_address|checkpoint)/i.test(
                url,
            );

        if (isLoginOrInterstitial) {
            console.log(
                `ℹ️ Waiting for Nextdoor login/interstitial: ${url}`,
            );

            // Do not redirect away from a login or verification screen.
            hydratingStartedAt = null;

            await sleep(2_500);
            continue;
        }

        if (!hydratingStartedAt) {
            hydratingStartedAt = Date.now();
        }

        const hydratingForMs =
            Date.now() - hydratingStartedAt;

        console.log(
            `   Nextdoor page is open but still hydrating: ${url}`,
        );

        // A stale search page can remain open without ever rendering
        // the global search box. Force a clean feed after 15 seconds.
        if (
            !forcedFeedNavigation &&
            hydratingForMs >= 15_000
        ) {
            forcedFeedNavigation = true;

            console.log(
                "🧭 Nextdoor is stuck on a stale page. Opening a clean news feed...",
            );

            await page
                .goto("https://nextdoor.com/news_feed/", {
                    waitUntil: "domcontentloaded",
                    timeout: 60_000,
                })
                .catch((error) => {
                    console.log(
                        `ℹ️ Forced feed navigation is still settling: ${error.message}`,
                    );
                });

            await sleep(7_000);
            continue;
        }

        // If the clean feed also fails to hydrate, reload it once.
        if (
            forcedFeedNavigation &&
            !forcedReload &&
            hydratingForMs >= 45_000
        ) {
            forcedReload = true;

            console.log(
                "🔄 Nextdoor feed still has not hydrated. Reloading once...",
            );

            await page
                .reload({
                    waitUntil: "domcontentloaded",
                    timeout: 60_000,
                })
                .catch((error) => {
                    console.log(
                        `ℹ️ Feed reload is still settling: ${error.message}`,
                    );
                });

            await sleep(7_000);
            continue;
        }

        await sleep(2_500);
    }

    throw new Error(
        "Nextdoor did not become ready after clean-feed navigation and one reload.",
    );
}

async function goToPostsTab(page, query) {
    const candidates = [
        page.getByRole("tab", { name: /^Posts$/i }).first(),
        page.locator('[data-testid="tab-posts"]').first(),
        page.locator("a,button").filter({ hasText: /^Posts$/i }).first(),
    ];

    for (const candidate of candidates) {
        try {
            if (
                (await candidate.count()) &&
                (await candidate.isVisible())
            ) {
                await candidate.click();
                await sleep(1_600);
                console.log("✅ Opened Posts results.");
                return;
            }
        } catch {}
    }

    await page.goto(
        `https://nextdoor.com/search/posts/?query=${encodeURIComponent(query)}`,
        {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
        },
    );

    await sleep(2_000);
    console.log("✅ Opened Posts results directly.");
}

async function applyMostRecentFilter(page) {
    console.log("🔃 Applying Most Recent sort...");

    const triggerCandidates = [
        page.locator('[aria-label="Sort By"]').first(),
        page.locator('div[role="button"][aria-label="Sort By"]').first(),
        page
            .locator("button, [role=button]")
            .filter({ hasText: /^(Most Relevant|Most Recent)$/i })
            .first(),
    ];

    let trigger = null;

    for (const candidate of triggerCandidates) {
        if (
            (await candidate.count().catch(() => 0)) &&
            (await candidate.isVisible().catch(() => false))
        ) {
            trigger = candidate;
            break;
        }
    }

    if (!trigger) {
        console.log("ℹ️ Could not find the sort control.");
        return false;
    }

    const currentText = cleanText(await trigger.innerText().catch(() => ""));

    if (/most recent/i.test(currentText)) {
        console.log("✅ Most Recent was already selected.");
        return true;
    }

    await trigger.click();
    await sleep(500);

    const optionCandidates = [
        page.getByRole("menuitem", { name: /^Most Recent$/i }).first(),
        page.getByRole("option", { name: /^Most Recent$/i }).first(),
        page.getByText(/^Most Recent$/i).last(),
    ];

    for (const option of optionCandidates) {
        if (
            (await option.count().catch(() => 0)) &&
            (await option.isVisible().catch(() => false))
        ) {
            await option.click();
            await sleep(1_000);
            console.log("✅ Applied Most Recent.");
            return true;
        }
    }

    console.log("ℹ️ Most Recent option was not found.");
    return false;
}

async function applyDistanceFilter(page, targetMiles = 15) {
    console.log(`📍 Applying ${targetMiles}-mile distance filter...`);

    const triggerCandidates = [
        page
            .getByRole("button", {
                name: /(?:\d+\s*miles?|distance)/i,
            })
            .first(),
        page
            .locator("button, [role=button]")
            .filter({ hasText: /\d+\s*miles?/i })
            .first(),
    ];

    let trigger = null;

    for (const candidate of triggerCandidates) {
        if (
            (await candidate.count().catch(() => 0)) &&
            (await candidate.isVisible().catch(() => false))
        ) {
            trigger = candidate;
            break;
        }
    }

    if (!trigger) {
        console.log("ℹ️ Could not find the distance control.");
        return false;
    }

    const currentText = cleanText(await trigger.innerText().catch(() => ""));

    if (new RegExp(`^${targetMiles}\\s*miles?$`, "i").test(currentText)) {
        console.log(`✅ Distance was already ${targetMiles} miles.`);
        return true;
    }

    await trigger.click();
    await sleep(500);

    const exactLabel = new RegExp(`^${targetMiles}\\s*miles?$`, "i");

    const optionCandidates = [
        page.getByRole("menuitem", { name: exactLabel }).first(),
        page.getByRole("option", { name: exactLabel }).first(),
        page.getByText(exactLabel).last(),
    ];

    for (const option of optionCandidates) {
        if (
            (await option.count().catch(() => 0)) &&
            (await option.isVisible().catch(() => false))
        ) {
            await option.click();
            await sleep(1_000);
            console.log(`✅ Applied ${targetMiles} miles.`);
            return true;
        }
    }

    const slider = page.locator('.rc-slider-handle[role="slider"]').first();

    if (
        (await slider.count().catch(() => 0)) &&
        (await slider.isVisible().catch(() => false))
    ) {
        await slider.focus();

        let current = Number(await slider.getAttribute("aria-valuenow"));

        if (!Number.isFinite(current)) current = 1;

        while (current > 1) {
            await page.keyboard.press("ArrowLeft");
            current -= 1;
        }

        for (let value = 1; value < targetMiles; value += 1) {
            await page.keyboard.press("ArrowRight");
        }

        await sleep(800);

        const finalValue = await slider.getAttribute("aria-valuenow");

        console.log(
            `✅ Distance slider set to ${finalValue || targetMiles} miles.`,
        );

        await page.keyboard.press("Escape").catch(() => {});
        return true;
    }

    console.log(
        `ℹ️ Could not find the ${targetMiles}-mile option or slider.`,
    );
    return false;
}


async function applyDateFilter(page, targetLabel = "Today") {
    console.log(`🗓️ Applying "${targetLabel}" date filter...`);

    const anyDateLabel =
        /^(All Time|Today|This Week|This Month|This Year)$/i;
    const targetRegex = targetLabel === "This Week"
        ? /^This Week$/i
        : /^Today$/i;

    const triggerCandidates = [
        page.getByRole("button", { name: anyDateLabel }).first(),
        page
            .locator("button, [role=button]")
            .filter({ hasText: anyDateLabel })
            .first(),
    ];

    let trigger = null;

    for (const candidate of triggerCandidates) {
        if (
            (await candidate.count().catch(() => 0)) &&
            (await candidate.isVisible().catch(() => false))
        ) {
            trigger = candidate;
            break;
        }
    }

    if (!trigger) {
        throw new Error(
            `DATE_FILTER_NOT_FOUND: ${targetLabel}`,
        );
    }

    const before = cleanText(
        await trigger.innerText().catch(() => "")
    );

    if (!targetRegex.test(before)) {
        await trigger.click();
        await sleep(500);

        const optionCandidates = [
            page.getByRole("menuitem", { name: targetRegex }).first(),
            page.getByRole("option", { name: targetRegex }).first(),
            page.getByText(targetRegex).last(),
        ];

        let clicked = false;

        for (const option of optionCandidates) {
            if (
                (await option.count().catch(() => 0)) &&
                (await option.isVisible().catch(() => false))
            ) {
                await option.click();
                clicked = true;
                break;
            }
        }

        if (!clicked) {
            throw new Error(
                `DATE_FILTER_OPTION_NOT_FOUND: ${targetLabel}`,
            );
        }

        await sleep(1_200);
    }

    const verifyTrigger = page
        .locator("button, [role=button]")
        .filter({ hasText: anyDateLabel })
        .first();

    const after = cleanText(
        await verifyTrigger.innerText().catch(() => "")
    );

    if (!targetRegex.test(after)) {
        throw new Error(
            `DATE_FILTER_NOT_APPLIED: expected ${targetLabel}, saw "${after || "unknown"}"`,
        );
    }

    console.log(
        `✅ Visible Nextdoor date filter verified: ${targetLabel}`,
    );

    return true;
}

async function applySearchFiltersByUrl(page, query) {
    const currentUrl = new URL(page.url());

    const {
        miles: targetMiles,
        dateParam,
        dateLabel
    } = getSearchFilterConfig(query);


    if (!/(^|\.)nextdoor\.com$/i.test(currentUrl.hostname)) {
        throw new Error(
            `Unexpected search URL before applying filters: ${page.url()}`,
        );
    }

    console.log("🔗 Nextdoor-generated search URL:");
    console.log(`   ${currentUrl.toString()}`);

    // Preserve Nextdoor-generated values such as ssid/search IDs, but force
    // the Posts screen and the exact filters needed for this scraper.
    currentUrl.searchParams.set("navigationScreen", "POST");
    currentUrl.searchParams.set("query", query);
    currentUrl.searchParams.set(
        "postSortOrder",
        "SORT_BY_RECENCY",
    );
    currentUrl.searchParams.set(
        "postDistance",
        String(targetMiles),
    );
    currentUrl.searchParams.set(
        "postDistanceUnit",
        "MILES",
    );
    currentUrl.searchParams.set("postDateFilter", dateParam);

    const targetUrl = currentUrl.toString();

    console.log("🔗 Applying search filters through the URL:");
    console.log(
        `   Posts + Most Recent + ${targetMiles} miles + ${dateLabel}`
    );
    console.log(`   ${targetUrl}`);

    await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
    });

    await sleep(3_500);

    const appliedUrl = new URL(page.url());

    const applied = {
        navigationScreen:
            appliedUrl.searchParams.get("navigationScreen"),
        query: appliedUrl.searchParams.get("query"),
        postSortOrder:
            appliedUrl.searchParams.get("postSortOrder"),
        postDistance:
            appliedUrl.searchParams.get("postDistance"),
        postDistanceUnit:
            appliedUrl.searchParams.get("postDistanceUnit"),
        postDateFilter:
            appliedUrl.searchParams.get("postDateFilter"),
    };

    console.log("✅ URL filter state:", applied);

    const filtersAreCorrect =
        applied.navigationScreen === "POST" &&
        applied.query === query &&
        applied.postSortOrder === "SORT_BY_RECENCY" &&
        applied.postDistance === String(targetMiles) &&
        applied.postDistanceUnit === "MILES" &&
        applied.postDateFilter === dateParam

    if (!filtersAreCorrect) {
        throw new Error(
            "Nextdoor removed or changed one or more URL filter parameters.",
        );
    }
}

async function searchNextdoor(page, query) {
    console.log("");
    console.log("============================================================");
    console.log(`🔍 Searching Nextdoor for "${query}"...`);
    console.log("============================================================");

    if (!/nextdoor\.com/i.test(page.url())) {
        await page.goto("https://nextdoor.com/news_feed/", {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
        });
    }

    let searchBox = await findVisibleSearchBox(page);

    if (!searchBox) {
        console.log(
            `⏳ Search bar is not visible yet; waiting up to ` +
            `${Math.round(SEARCH_READY_TIMEOUT_MS / 1_000)} more seconds...`,
        );

        const deadline = Date.now() + SEARCH_READY_TIMEOUT_MS;

        while (Date.now() < deadline && !searchBox) {
            await sleep(1_500);
            searchBox = await findVisibleSearchBox(page);
        }
    }


    if (!searchBox) {
        throw new Error(
            "Could not find the Nextdoor search bar after waiting for the feed.",
        );
    }

    await searchBox.click();
    await searchBox.fill(query);
    await page.keyboard.press("Enter");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(3_000);

    // Get the correct filters for this search term.
    const filterConfig = getSearchFilterConfig(query);

    console.log(
        `🎯 Search configuration for "${query}": ` +
        `${filterConfig.miles} miles + ${filterConfig.dateLabel}`
    );

    // Use URL parameters for navigation, but do not trust them as proof
    // that Nextdoor actually applied the requested result window.
    try {
        await applySearchFiltersByUrl(page, query);
    } catch (error) {
        console.warn(
            `⚠️ URL filter navigation failed for "${query}": ${error.message}`
        );
    }

    // Physically set and verify the visible controls before collecting cards.
    await goToPostsTab(page, query);
    await applyMostRecentFilter(page);

    const distanceApplied = await applyDistanceFilter(
        page,
        filterConfig.miles
    );

    if (!distanceApplied) {
        throw new Error(
            `DISTANCE_FILTER_NOT_APPLIED:${filterConfig.miles} miles:${query}`
        );
    }

    await applyDateFilter(page, filterConfig.dateLabel);
    await sleep(1_800);

    console.log(
        `✅ Visible filters verified for "${query}": ` +
        `${filterConfig.miles} miles + ${filterConfig.dateLabel}`
    );

    const throttle = await detectNextdoorThrottle(page);

    if (throttle) {
        console.error(
            `⛔ Nextdoor throttled search for "${query}". ` +
            `Requested wait: ${throttle.waitSeconds} seconds.`,
        );

        throw new Error(
            `NEXTDOOR_THROTTLED:${throttle.waitSeconds}:${query}`,
        );
    }
}

async function collectPostLinks(page, limit = MAX_POSTS_PER_TERM) {
    console.log("⬇️ Loading search results...");

    let previousCount = -1;
    let stablePasses = 0;

    for (let pass = 1; pass <= 20; pass += 1) {
        const count = await page
            .locator('a[href*="/p/"], a[href*="/posting/"]')
            .count();

        console.log(`   pass ${pass}: ${count} links loaded`);

        stablePasses =
            count === previousCount ? stablePasses + 1 : 0;

        previousCount = count;

        if (stablePasses >= 4) break;

        await page.mouse.wheel(0, 1_700);
        await sleep(900);
    }

    const raw = await page.evaluate((maxResults) => {
        const results = [];
        const clean = (value) =>
            (value || "").replace(/\s+/g, " ").trim();

        for (const anchor of document.querySelectorAll(
            'a[href*="/p/"], a[href*="/posting/"]',
        )) {
            const href = anchor.href;
            if (!href) continue;

            const root =
                anchor.closest("article, [role=article], li") ||
                anchor.parentElement;

            const preview = clean(
                root?.innerText ||
                anchor.innerText ||
                ""
            );

            if (preview.length < 15) continue;

            let author = null;

            const avatar = root?.querySelector(
                '[aria-label*="Avatar for" i]'
            );

            const avatarLabel =
                avatar?.getAttribute("aria-label") || "";

            if (avatarLabel) {
                author = clean(
                    avatarLabel.replace(/^Avatar for\s*/i, "")
                );
            }

            if (!author) {
                const profileLink = root?.querySelector(
                    'a[href*="/profile/"]'
                );

                const profileText = clean(profileLink?.textContent);

                if (
                    profileText &&
                    profileText.length <= 100
                ) {
                    author = profileText;
                }
            }

            let location = null;
            let postedAtText = null;

            const styledTexts = [
                ...(root?.querySelectorAll(
                    '[data-testid="styled-text"]'
                ) || []),
            ]
                .map((element) => clean(element.textContent))
                .filter(Boolean);

            for (const text of styledTexts) {
                const match = text.match(
                    /^(.+?),\s*([A-Z]{2})\s*·\s*([^·]+)(?:\s*·|$)/i,
                );

                if (match) {
                    location =
                        clean(match[1]) + ", " + match[2].toUpperCase();
                    postedAtText = clean(match[3]);
                    break;
                }

                const locationOnly = text.match(
                    /^(.+?),\s*([A-Z]{2})\s*·\s*/i,
                );

                if (locationOnly && !location) {
                    location =
                        clean(locationOnly[1]) +
                        ", " +
                        locationOnly[2].toUpperCase();
                }
            }

            results.push({
                url: href,
                preview: preview.slice(0, 1_500),
                author: author || null,
                location: location || null,
                posted_at_text: postedAtText || null,
            });

            if (results.length >= maxResults * 3) break;
        }

        return results;
    }, limit);

    const posts = [];
    const collectedByUrl = new Map();
    let sameCardDuplicates = 0;
    let reusedUrlVariants = 0;

    for (const rawPost of raw) {
        const post = {
            ...rawPost,
            url: normalizePostUrl(rawPost.url),
        };

        const priorPosts = collectedByUrl.get(post.url) || [];

        const duplicate = priorPosts.some((prior) =>
            authorsCompatibleForDuplicate(
                prior.author,
                post.author,
            ) &&
            descriptionsLookLikeSamePost(
                prior.preview,
                post.preview,
            )
        );

        if (duplicate) {
            sameCardDuplicates += 1;
            continue;
        }

        if (priorPosts.length > 0) {
            reusedUrlVariants += 1;
            console.warn(
                `⚠️ Same search returned one URL with different card content: ${post.url}`,
            );
        }

        priorPosts.push(post);
        collectedByUrl.set(post.url, priorPosts);
        posts.push(post);

        if (posts.length >= limit) break;
    }

    console.log(
        `🔗 Found ${posts.length} distinct post card(s); ` +
        `${sameCardDuplicates} duplicate anchor/card(s) collapsed; ` +
        `${reusedUrlVariants} reused-URL variant(s) preserved.`,
    );

    return posts;
}

const OTHER_LEAD_TABLE = "unfiltered_general_contracting";

async function getExistingUrls(posts) {
    const urls = posts
        .map((post) => normalizePostUrl(post.url))
        .filter(Boolean);

    if (!urls.length) return new Set();

    const { rows } = await pool.query(
        `
            SELECT
                post_url,
                author,
                description,
                'current'::text AS source
            FROM ${TABLE_NAME}
            WHERE post_url = ANY($1::text[])

            UNION ALL

            SELECT
                post_url,
                author,
                description,
                'other'::text AS source
            FROM ${OTHER_LEAD_TABLE}
            WHERE post_url = ANY($1::text[])
        `,
        [urls],
    );

    const postsByUrl = new Map();

    for (const post of posts) {
        const url = normalizePostUrl(post.url);

        if (!postsByUrl.has(url)) {
            postsByUrl.set(url, []);
        }

        postsByUrl.get(url).push(post);
    }

    const existingUrls = new Set();
    let crossTableMatches = 0;
    let reusedUrlMismatches = 0;

    for (const row of rows) {
        const url = normalizePostUrl(row.post_url);

        // The destination table owns post_url. Never allow a second record
        // with that URL to overwrite the existing row through ON CONFLICT.
        if (row.source === "current") {
            existingUrls.add(url);
            continue;
        }

        const candidates = postsByUrl.get(url) || [];

        const samePost = candidates.some((post) =>
            authorsCompatibleForDuplicate(
                row.author,
                post.author,
            ) &&
            descriptionsLookLikeSamePost(
                row.description,
                post.preview,
            )
        );

        if (samePost) {
            existingUrls.add(url);
            crossTableMatches += 1;
        } else {
            reusedUrlMismatches += 1;
        }
    }

    if (crossTableMatches > 0) {
        console.log(
            `🧱 Cross-table historical duplicate matches: ${crossTableMatches}.`,
        );
    }

    if (reusedUrlMismatches > 0) {
        console.warn(
            `⚠️ Reused/mismatched historical URL(s) not treated as duplicates: ` +
            `${reusedUrlMismatches}.`,
        );
    }

    return existingUrls;
}

async function purgeExpiredSearchHistory() {
    const resultDelete = await pool.query(
        `
            DELETE FROM ${SEARCH_RESULTS_TABLE}
            WHERE expires_at < NOW()
        `,
    );

    const runDelete = await pool.query(
        `
            DELETE FROM ${SEARCH_RUNS_TABLE} r
            WHERE r.started_at < NOW() - INTERVAL '35 days'
              AND NOT EXISTS (
                  SELECT 1
                  FROM ${SEARCH_RESULTS_TABLE} s
                  WHERE s.run_id = r.run_id
              )
        `,
    );

    console.log(
        `🧹 Search-history cleanup: ${resultDelete.rowCount} observation(s) ` +
        `and ${runDelete.rowCount} old run(s) removed.`,
    );
}

async function createSearchRun(
    runId,
    plannedSearchTerms =
    SEARCH_TERMS.length,
) {
    await pool.query(
        `
            INSERT INTO ${SEARCH_RUNS_TABLE}
            (
                run_id,
                status,
                planned_search_terms
            )
            VALUES ($1, 'running', $2)
            ON CONFLICT (run_id) DO NOTHING
        `,
        [
            runId,
            plannedSearchTerms,
        ],
    );

    console.log(
        `🧠 Search-learning run started: ${runId} ` +
        `(${plannedSearchTerms} term(s)).`,
    );
}

async function finishSearchRun(runId, status, totals, error = null) {
    await pool.query(
        `
            UPDATE ${SEARCH_RUNS_TABLE}
            SET
                completed_at = NOW(),
                status = $2,
                total_result_observations = $3,
                total_unique_result_urls = $4,
                total_existing_posts = $5,
                total_cross_term_duplicates = $6,
                total_new_candidates = $7,
                total_inserted = $8,
                total_failed = $9,
                run_error = $10
            WHERE run_id = $1
        `,
        [
            runId,
            status,
            totals.resultObservations || 0,
            totals.uniqueResultUrls || 0,
            totals.existingSkipped || 0,
            totals.crossTermSkipped || 0,
            totals.newCandidates || 0,
            totals.inserted || 0,
            totals.failed || 0,
            error ? String(error).slice(0, 4000) : null,
        ],
    );
}

async function logSearchObservations({
                                         runId,
                                         query,
                                         expectedLeadTypes,
                                         posts,
                                         existingUrls,
                                         crossTermUrls,
                                     }) {
    if (!posts.length) return 0;

    const values = [];
    const placeholders = [];

    posts.forEach((post, index) => {
        const base = values.length;
        const postUrl = normalizePostUrl(post.url);

        values.push(
            runId,
            query,
            expectedLeadTypes,
            SEARCH_TERM_SOURCE,
            index + 1,
            postUrl,
            cleanText(post.preview || "").slice(0, 1500) || null,
            existingUrls.has(postUrl),
            crossTermUrls.has(postUrl),
        );

        placeholders.push(
            `($${base + 1}, $${base + 2}, $${base + 3}::text[], ` +
            `$${base + 4}, $${base + 5}, $${base + 6}, ` +
            `$${base + 7}, $${base + 8}, $${base + 9})`,
        );
    });

    await pool.query(
        `
            INSERT INTO ${SEARCH_RESULTS_TABLE}
            (
                run_id,
                search_term,
                expected_lead_types,
                term_source,
                result_position,
                post_url,
                preview,
                was_existing,
                cross_term_duplicate
            )
            VALUES ${placeholders.join(",\n")}
            ON CONFLICT (run_id, search_term, post_url)
            DO UPDATE SET
                expected_lead_types = EXCLUDED.expected_lead_types,
                term_source = EXCLUDED.term_source,
                result_position = EXCLUDED.result_position,
                preview = EXCLUDED.preview,
                was_existing = EXCLUDED.was_existing,
                cross_term_duplicate = EXCLUDED.cross_term_duplicate
        `,
        values,
    );

    console.log(
        `📝 Search audit: recorded all ${posts.length} result observation(s) ` +
        `for "${query}" before duplicate filtering.`,
    );

    return posts.length;
}

async function markAuditInserted(runId, query, postUrl, leadId) {
    await pool.query(
        `
            UPDATE ${SEARCH_RESULTS_TABLE}
            SET inserted_new = TRUE,
                inserted_lead_id = $4,
                scraper_error = NULL
            WHERE run_id = $1
              AND search_term = $2
              AND post_url = $3
        `,
        [runId, query, normalizePostUrl(postUrl), leadId],
    );
}

async function markAuditError(runId, query, postUrl, error) {
    await pool.query(
        `
            UPDATE ${SEARCH_RESULTS_TABLE}
            SET scraper_error = $4
            WHERE run_id = $1
              AND search_term = $2
              AND post_url = $3
        `,
        [
            runId,
            query,
            normalizePostUrl(postUrl),
            String(error || "unknown error").slice(0, 2000),
        ],
    );
}

async function expandSeeMore(page) {
    const buttons = page.locator(
        'button:has-text("See more"), [data-testid="see-more-text"]',
    );

    const count = Math.min(await buttons.count(), 4);

    for (let index = 0; index < count; index += 1) {
        try {
            if (await buttons.nth(index).isVisible()) {
                await buttons.nth(index).click({ timeout: 1_200 });
                await sleep(250);
            }
        } catch {}
    }
}

async function extractAuthor(page) {
    const selectors = [
        'a[href*="/profile/"][href*="detail_author"]',
        'a[href*="/profile/"][href*="is=detail_author"]',
        'main article a[href*="/profile/"]',
        'a[href*="/profile/"]',
    ];

    for (const selector of selectors) {
        const links = page.locator(selector);
        const count = Math.min(await links.count(), 15);

        for (let index = 0; index < count; index += 1) {
            try {
                const link = links.nth(index);
                const text = cleanText(await link.innerText());

                if (
                    /^[A-Z][A-Za-zÀ-ÖØ-öø-ÿ.'’\-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ.'’\-]+){1,5}$/.test(
                        text,
                    )
                ) {
                    return text;
                }

                const aria = await link
                    .locator('[aria-label*="Avatar for" i]')
                    .first()
                    .getAttribute("aria-label")
                    .catch(() => null);

                if (aria) {
                    return cleanText(
                        aria.replace(/^Avatar for\s*/i, ""),
                    );
                }
            } catch {}
        }
    }

    return null;
}


async function extractPostDetails(detailPage, post, searchTerm) {
    const url = normalizePostUrl(post.url);

    await detailPage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
    });

    await detailPage
        .waitForURL(
            (current) =>
                normalizePostUrl(current.href) === url,
            { timeout: 12_000 },
        )
        .catch(() => {});

    await sleep(1_400);
    await expandSeeMore(detailPage);

    const author = await extractAuthor(detailPage);

    const extracted = await detailPage.evaluate(
        ({ preview }) => {
            const clean = (value) =>
                (value || "").replace(/\s+/g, " ").trim();

            const junk =
                /Home For Sale & Free Local News Ask Alerts Groups Events Post Settings Help Center/i;

            const tokens = clean(preview)
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter((word) => word.length >= 4);

            const tokenSet = new Set(tokens.slice(0, 80));
            const candidates = [];

            const selectors = [
                '[data-testid="post-body-text"]',
                '[data-testid="styled-text-wrapper"]',
                'span[data-testid="styled-text"]',
                ".postTextBodySpan",
                'main [dir="auto"]',
            ];

            for (const selector of selectors) {
                for (const element of document.querySelectorAll(selector)) {
                    const text = clean(
                        element.innerText ||
                        element.textContent,
                    );

                    if (
                        text.length < 20 ||
                        text.length > 7_000 ||
                        junk.test(text)
                    ) {
                        continue;
                    }

                    const words = text
                        .toLowerCase()
                        .split(/[^a-z0-9]+/);

                    const overlap = words.reduce(
                        (total, word) =>
                            total + (tokenSet.has(word) ? 1 : 0),
                        0,
                    );

                    candidates.push({
                        text,
                        score:
                            overlap * 100 +
                            Math.min(text.length, 1_500),
                    });
                }
            }

            candidates.sort((a, b) => b.score - a.score);

            const description =
                candidates[0]?.text ||
                clean(preview) ||
                null;

            let location = null;

            const neighborhoodLinks = [
                ...document.querySelectorAll(
                    'a[href*="/neighborhood/"]',
                ),
            ];

            for (const link of neighborhoodLinks) {
                const text = clean(link.innerText);

                if (text && text.length < 100) {
                    location = text;
                    break;
                }
            }

            if (!location) {
                const lines = document.body.innerText
                    .split("\n")
                    .map(clean)
                    .filter(Boolean);

                const explicit = lines.find((line) =>
                    /^[A-Za-z .'-]+,\s*[A-Z]{2}$/.test(line),
                );

                if (explicit) location = explicit;
            }

            return {
                description,
                location,
            };
        },
        { preview: post.preview },
    );

    const description = cleanText(
        extracted.description || post.preview,
    );

    const location = cleanText(
        extracted.location || "",
    );

    const cityState = await resolveCityState({
        location,
        description,
    });

    const leadTypes = getLeadTypesForSearchTerm(searchTerm);

    return {
        author,
        location: location || null,
        description,
        post_url: url,
        city: cityState.city,
        state: cityState.state,
        lead_type: leadTypes,
        search_term: searchTerm,
        posted_at_text: post.posted_at_text || null,
        posted_at: (() => {
            const parsed = parseNextdoorPostTimestamp(post.posted_at_text);
            if (!parsed || new Date(parsed).getTime() > Date.now() + 60_000) return null;
            return parsed;
        })(),
    };
}


async function insertUnfilteredGeneralContracting(record) {
    const query = `
        INSERT INTO ${TABLE_NAME}
        (
            author,
            location,
            description,
            post_url,
            city,
            state,
            lead_type,
            timestamp,
            original_post_at,
            posted_at_text
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7::text[],
            COALESCE($8::timestamp, NOW()),
            $9::timestamptz,
            $10::text
        )
            ON CONFLICT (post_url) DO UPDATE SET
            author = COALESCE(
                                          EXCLUDED.author,
                                          ${TABLE_NAME}.author
                                          ),
                                          location = COALESCE(
                                          EXCLUDED.location,
                                          ${TABLE_NAME}.location
                                          ),
                                          description = COALESCE(
                                          EXCLUDED.description,
                                          ${TABLE_NAME}.description
                                          ),
                                          city = COALESCE(
                                          EXCLUDED.city,
                                          ${TABLE_NAME}.city
                                          ),
                                          state = COALESCE(
                                          EXCLUDED.state,
                                          ${TABLE_NAME}.state
                                          ),
                                          lead_type = ARRAY(
                                          SELECT DISTINCT value
                                          FROM unnest(
                                          COALESCE(
                                          ${TABLE_NAME}.lead_type,
                                          ARRAY[]::text[]
                                          ) ||
                                          COALESCE(
                                          EXCLUDED.lead_type,
                                          ARRAY[]::text[]
                                          )
                                          ) AS value
                                          WHERE value IS NOT NULL
                                          AND BTRIM(value) <> ''
                                          ),
            original_post_at = COALESCE(EXCLUDED.original_post_at, ${TABLE_NAME}.original_post_at),
            posted_at_text = COALESCE(EXCLUDED.posted_at_text, ${TABLE_NAME}.posted_at_text)
                                          RETURNING id
    `;

    const { rows } = await pool.query(query, [
        record.author,
        record.location,
        record.description,
        record.post_url,
        record.city,
        record.state,
        Array.isArray(record.lead_type)
            ? record.lead_type
            : [record.lead_type],
        record.posted_at || null,
        record.posted_at || null,
        record.posted_at_text || null,
    ]);

    console.log(
        `✅ Saved: ${record.author || "(unknown)"} → ` +
        `${record.city || "(unknown city)"}, ` +
        `${record.state || "(unknown state)"}`,
    );

    return rows[0]?.id || null;
}

async function collectPostsForSearchTerm(context, query) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= SEARCH_PAGE_MAX_ATTEMPTS;
        attempt += 1
    ) {
        let searchPage = null;
        const crashCountAtStart =
            asynchronousTargetCrashCount;

        try {
            console.log(
                `🧼 Opening fresh search page ` +
                `(${attempt}/${SEARCH_PAGE_MAX_ATTEMPTS}) for "${query}"...`,
            );

            searchPage = await createConfiguredPage(
                context,
                `search:${query}:attempt:${attempt}`,
            );

            await searchNextdoor(searchPage, query);

            const posts = await collectPostLinks(
                searchPage,
                MAX_POSTS_PER_TERM,
            );

            if (
                asynchronousTargetCrashCount >
                crashCountAtStart
            ) {
                throw new Error(
                    `Target crashed while searching for "${query}".`,
                );
            }

            return posts;

        } catch (error) {
            lastError = error;

            if (
                browserDisconnected ||
                isBrowserDisconnectedError(error)
            ) {
                throw new Error(
                    `BROWSER_DISCONNECTED while searching for "${query}": ` +
                    getErrorMessage(error),
                );
            }

            // A throttle should NOT be retried.
            // Let it bubble up to the main search loop so the whole run stops.
            if (isNextdoorThrottleError(error)) {
                throw error;
            }

            console.error(
                `❌ Search attempt ${attempt}/` +
                `${SEARCH_PAGE_MAX_ATTEMPTS} failed for "${query}": ` +
                getErrorMessage(error),
            );

            if (attempt < SEARCH_PAGE_MAX_ATTEMPTS) {
                const delayMs = attempt * 2_000;

                console.log(
                    `♻️ Retrying "${query}" with a completely fresh ` +
                    `search page in ${delayMs / 1_000} seconds...`,
                );

                await sleep(delayMs);
            }

        } finally {
            await closePageSafely(
                searchPage,
                `search page for "${query}"`,
            );
        }
    }

    throw new Error(
        `Search failed after ${SEARCH_PAGE_MAX_ATTEMPTS} attempt(s) ` +
        `for "${query}": ${getErrorMessage(lastError)}`,
    );
}

async function extractPostDetailsWithFreshPage(
    context,
    post,
    searchTerm,
) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= DETAIL_PAGE_MAX_ATTEMPTS;
        attempt += 1
    ) {
        let detailPage = null;
        const crashCountAtStart =
            asynchronousTargetCrashCount;

        try {
            console.log(
                `🧼 Opening fresh detail page ` +
                `(${attempt}/${DETAIL_PAGE_MAX_ATTEMPTS})...`,
            );

            detailPage = await createConfiguredPage(
                context,
                `detail:${searchTerm}:attempt:${attempt}`,
            );

            const record = await extractPostDetails(
                detailPage,
                post,
                searchTerm,
            );

            if (
                asynchronousTargetCrashCount >
                crashCountAtStart
            ) {
                throw new Error(
                    `Target crashed while opening ${post.url}.`,
                );
            }

            return record;
        } catch (error) {
            lastError = error;

            if (
                browserDisconnected ||
                isBrowserDisconnectedError(error)
            ) {
                throw new Error(
                    `BROWSER_DISCONNECTED while opening ${post.url}: ` +
                    getErrorMessage(error),
                );
            }

            console.error(
                `❌ Detail attempt ${attempt}/` +
                `${DETAIL_PAGE_MAX_ATTEMPTS} failed: ` +
                getErrorMessage(error),
            );

            if (
                attempt < DETAIL_PAGE_MAX_ATTEMPTS &&
                isRetryablePageError(error)
            ) {
                const delayMs = attempt * 1_500;

                console.log(
                    `♻️ Retrying post with a fresh detail page in ` +
                    `${delayMs / 1_000} seconds...`,
                );

                await sleep(delayMs);
                continue;
            }

            break;
        } finally {
            await closePageSafely(
                detailPage,
                `detail page for ${post.url}`,
            );
        }
    }

    throw lastError || new Error(
        `Could not extract post details for ${post.url}.`,
    );
}


async function processSearchTerm({
                                     context,
                                     query,
                                     runId,
                                     seenDuringRun,
                                 }) {
    const expectedLeadTypes = getLeadTypesForSearchTerm(query);

    const allPosts = await collectPostsForSearchTerm(
        context,
        query,
    );

    // Check all results before cross-term filtering
    // so the audit captures existing database records.
    const existingAll = await getExistingUrls(allPosts);
    const crossTermUrls = new Set();
    const uniqueForThisRun = [];

    for (const post of allPosts) {
        const url = normalizePostUrl(post.url);

        if (isCrossTermDuplicate(seenDuringRun, post)) {
            crossTermUrls.add(url);
            continue;
        }

        uniqueForThisRun.push(post);
    }

    await logSearchObservations({
        runId,
        query,
        expectedLeadTypes,
        posts: allPosts,
        existingUrls: existingAll,
        crossTermUrls,
    });

    console.log(
        `🔎 Search "${query}" → ${expectedLeadTypes.join(", ") || "unclassified"}`
    );

    console.log(
        `🔁 Cross-term duplicate check: ` +
        `${crossTermUrls.size} already found ` +
        `during this run, ${uniqueForThisRun.length} remain.`,
    );

    const existing = new Set(
        uniqueForThisRun
            .map((post) => normalizePostUrl(post.url))
            .filter((url) => existingAll.has(url)),
    );

    const posts = uniqueForThisRun.filter(
        (post) =>
            !existingAll.has(normalizePostUrl(post.url)),
    );

    console.log(
        `🧱 Database duplicate check: ` +
        `${existing.size} existing, ${posts.length} new.`,
    );

    let inserted = 0;
    let failed = 0;

    for (let index = 0; index < posts.length; index += 1) {
        const post = posts[index];

        console.log(
            `\n[${index + 1}/${posts.length}] ` +
            `"${query}" → ${post.url}`,
        );

        try {
            const record =
                await extractPostDetailsWithFreshPage(
                    context,
                    post,
                    query,
                );

            console.dir(record, { depth: null });

            if (
                !record.description ||
                record.description.length < 10
            ) {
                console.log("⏭️ No usable description.");

                failed += 1;

                await markAuditError(
                    runId,
                    query,
                    post.url,
                    "No usable description",
                );

                continue;
            }

            const leadId =
                await insertUnfilteredGeneralContracting(record);

            await markAuditInserted(
                runId,
                query,
                post.url,
                leadId,
            );

            inserted += 1;
        } catch (error) {
            if (
                browserDisconnected ||
                isBrowserDisconnectedError(error)
            ) {
                throw error;
            }

            const message = getErrorMessage(error);

            console.error(
                `⏭️ Skipping post after fresh-page retries: ` +
                `${message}`,
            );

            await markAuditError(
                runId,
                query,
                post.url,
                message,
            ).catch((auditError) => {
                console.warn(
                    `⚠️ Could not record audit error for ${post.url}: ` +
                    `${getErrorMessage(auditError)}`,
                );
            });

            failed += 1;
        }

        await sleep(
            650 + Math.floor(Math.random() * 700),
        );
    }

    return {
        inserted,
        failed,
        existingSkipped: existing.size,
        crossTermSkipped: crossTermUrls.size,
        newCandidates: posts.length,
        resultObservations: allPosts.length,
        observedUrls: allPosts.map((post) =>
            normalizePostUrl(post.url),
        ),
    };
}


async function triggerFtnEnrichment({
                                        totalInserted,
                                        totalFailed,
                                        totalExistingSkipped,
                                        totalCrossTermSkipped,
                                    }) {
    if (!CRM_API_BASE_URL) {
        throw new Error(
            "CRM_API_BASE_URL is missing. Set it to the host that serves " +
            ENRICHMENT_ENDPOINT_PATH,
        );
    }

    const endpointUrl =
        process.env.FTN_TRIGGER_URL ||
        new URL(
            ENRICHMENT_ENDPOINT_PATH,
            CRM_API_BASE_URL,
        ).toString();

    const payload = {
        source_table: TABLE_NAME,
        lead_type: LEAD_TYPES,
        scrape_summary: {
            inserted: totalInserted,
            failed: totalFailed,
            existing_db_posts_skipped:
            totalExistingSkipped,
            cross_term_duplicates_skipped:
            totalCrossTermSkipped,
        },
    };

    const maxAttempts = Math.max(
        1,
        Number(process.env.FTN_TRIGGER_MAX_ATTEMPTS || 3),
    );

    const timeoutMs = Math.max(
        5_000,
        Number(process.env.FTN_TRIGGER_TIMEOUT_MS || 60_000),
    );

    let lastError = null;

    console.log("");
    console.log("============================================================");
    console.log("🚀 Sending FTN enrichment request...");
    console.log(`   Endpoint: ${endpointUrl}`);
    console.log(`   Source table: ${TABLE_NAME}`);
    console.log("============================================================");

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            console.log(
                `📡 FTN trigger attempt ${attempt}/${maxAttempts}...`,
            );

            const response = await fetch(endpointUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(timeoutMs),
            });

            const responseText = await response.text();

            console.log(
                `📡 FTN response status: ${response.status}`,
            );
            console.log(
                `📡 FTN response body: ` +
                `${responseText || "(empty body)"}`,
            );

            if (!response.ok) {
                throw new Error(
                    `FTN trigger returned HTTP ${response.status}: ` +
                    `${responseText || "(empty body)"}`,
                );
            }

            let responseBody = null;

            if (responseText) {
                try {
                    responseBody = JSON.parse(responseText);
                } catch {
                    responseBody = {
                        raw: responseText,
                    };
                }
            }

            if (responseBody?.success === false) {
                throw new Error(
                    `FTN trigger rejected the request: ` +
                    `${responseBody.error || responseText}`,
                );
            }

            console.log(
                "✅ FTN enrichment request was accepted.",
            );

            if (responseBody?.status) {
                console.log(
                    `   FTN status: ${responseBody.status}`,
                );
            }

            if (responseBody?.source_table) {
                console.log(
                    `   FTN source table: ` +
                    `${responseBody.source_table}`,
                );
            }

            if (
                responseBody?.queue_position !== undefined &&
                responseBody?.queue_position !== null
            ) {
                console.log(
                    `   Queue position: ` +
                    `${responseBody.queue_position}`,
                );
            }

            return responseBody;
        } catch (error) {
            lastError = error;

            console.error(
                `❌ FTN trigger attempt ${attempt} failed: ` +
                `${error.message}`,
            );

            if (attempt < maxAttempts) {
                const retryDelayMs = attempt * 3_000;

                console.log(
                    `⏳ Retrying FTN trigger in ` +
                    `${retryDelayMs / 1_000} seconds...`,
                );

                await sleep(retryDelayMs);
            }
        }
    }

    throw new Error(
        `FTN enrichment trigger failed after ${maxAttempts} ` +
        `attempt(s): ${lastError?.message || "unknown error"}`,
    );
}

async function main() {
    console.log(
        "🏗️ Nextdoor Combination Scraper Started",
    );

    if (!process.env.MULTILOGIN_WS) {
        throw new Error("MULTILOGIN_WS is missing.");
    }

    const runId = randomUUID();

    let browser = null;
    let bootstrapPage = null;
    let searchRunCreated = false;
    let searchRunFinished = false;

    const observedUrlsDuringRun = new Set();

    let totalResultObservations = 0;
    let totalNewCandidates = 0;
    let totalInserted = 0;
    let totalFailed = 0;
    let totalExistingSkipped = 0;
    let totalCrossTermSkipped = 0;

    const currentTotals = () => ({
        resultObservations: totalResultObservations,
        uniqueResultUrls: observedUrlsDuringRun.size,
        existingSkipped: totalExistingSkipped,
        crossTermSkipped: totalCrossTermSkipped,
        newCandidates: totalNewCandidates,
        inserted: totalInserted,
        failed: totalFailed,
    });

    try {
        await purgeExpiredSearchHistory();


        browser = await chromium.connectOverCDP(
            process.env.MULTILOGIN_WS,
        );

        browser.on("disconnected", () => {
            browserDisconnected = true;
            console.error(
                "💥 Playwright disconnected from the Multilogin browser.",
            );
        });

        const context = browser.contexts()[0];

        if (!context) {
            throw new Error(
                "No Multilogin browser context found.",
            );
        }

        // Confirm the saved Multilogin profile is logged in before opening
        // disposable pages for each search term and each new post.
        bootstrapPage = await waitForNextdoorReady(
            context,
            180_000,
        );

        // Multilogin restores tabs from the previous profile session. The log
        // showed 16 pages open before scraping began, which can exhaust the
        // container's PID/thread allowance even when each new page is closed.
        await closeStaleContextPages(context, bootstrapPage);
        await parkBootstrapPage(bootstrapPage);

        const seenDuringRun = new Map();

        const carryoverTerms =
            await fetchCarryoverSearchTerms();

        const carryoverKeys =
            new Set(
                carryoverTerms.map(
                    (query) =>
                        cleanText(query)
                            .toLowerCase(),
                ),
            );


        const normalTerms =
            SEARCH_TERMS.filter(
                (query) =>
                    !carryoverKeys.has(
                        cleanText(query)
                            .toLowerCase(),
                    ),
            );


        const randomizedCarryover =
            shuffleArray(
                carryoverTerms,
            );


        const randomizedNormal =
            shuffleArray(
                normalTerms,
            );


        const executionPlan = [
            ...randomizedCarryover,
            ...randomizedNormal,
        ];

        await createSearchRun(
            runId,
            executionPlan.length,
        );

        searchRunCreated = true;


        console.log(
            `♻️ Carryover terms prioritized: ` +
            `${randomizedCarryover.length}`,
        );

        console.log(
            `🔀 Normal terms randomized after carryover: ` +
            `${randomizedNormal.length}`,
        );

        console.log(
            `📋 Final combined execution plan: ` +
            `${executionPlan.length} term(s).`,
        );

        console.log(
            "🔀 First 10 terms this run:",
            executionPlan.slice(0, 10),
        );
        for (
            let termIndex = 0;
            termIndex <
            executionPlan.length;
            termIndex += 1
        ) {
            const query =
                executionPlan[termIndex];

            let lastTermResult = null;

            if (
                browserDisconnected ||
                !browser.isConnected()
            ) {
                throw new Error(
                    `BROWSER_DISCONNECTED before search term "${query}".`,
                );
            }

            try {
                const result = await processSearchTerm({
                    context,
                    query,
                    runId,
                    seenDuringRun,
                });

                lastTermResult = result;

                totalResultObservations +=
                    result.resultObservations;
                totalNewCandidates +=
                    result.newCandidates;
                totalInserted += result.inserted;
                totalFailed += result.failed;
                totalExistingSkipped +=
                    result.existingSkipped;
                totalCrossTermSkipped +=
                    result.crossTermSkipped;

                for (const url of result.observedUrls) {
                    observedUrlsDuringRun.add(url);
                }
            } catch (error) {
                if (
                    browserDisconnected ||
                    isBrowserDisconnectedError(error)
                ) {
                    throw error;
                }

                // Do NOT continue through the remaining search terms
                // if Nextdoor has rate-limited this session.
                if (
                    isNextdoorThrottleError(
                        error,
                    )
                ) {
                    const message =
                        getErrorMessage(error);

                    const parts =
                        message.split(":");

                    const waitSeconds =
                        Number(parts[1] || 0);


                    /*
                     * Include the currently throttled
                     * term itself.
                     *
                     * We cannot consider that search
                     * successfully completed.
                     */
                    const remainingTerms =
                        executionPlan.slice(
                            termIndex,
                        );


                    console.error(
                        "⛔ Nextdoor throttle detected. " +
                        "Saving unfinished combined terms " +
                        "before stopping this run.",
                    );


                    if (waitSeconds > 0) {
                        console.error(
                            `⏳ Nextdoor requested a cooldown of approximately ` +
                            `${waitSeconds} seconds.`,
                        );
                    }


                    await saveThrottleCarryover({
                        runId,

                        throttledTerm:
                        query,

                        waitSeconds,

                        remainingTerms,
                    });


                    throw error;
                }

                console.error(
                    `⏭️ Skipping search term "${query}" after ` +
                    `fresh-page retries: ${getErrorMessage(error)}`,
                );

                totalFailed += 1;
            }

            const interTermDelayMs =
                getAdaptiveTermDelayMs(lastTermResult || {});

            console.log(
                `🕒 Pacing before next term: ${Math.round(interTermDelayMs / 1000)}s ` +
                `(${lastTermResult?.newCandidates || 0} new detail candidate(s)).`,
            );

            await sleep(interTermDelayMs);
        }

        await finishSearchRun(
            runId,
            "completed",
            currentTotals(),
        );
        searchRunFinished = true;

        await clearCarryoverSearchTerms(
            runId,
        );

        console.log("");
        console.log(
            "============================================================",
        );
        console.log("✅ Combination scrape finished.");
        console.log(`   Inserted: ${totalInserted}`);
        console.log(`   Failed: ${totalFailed}`);
        console.log(
            `   Existing DB posts skipped: ${totalExistingSkipped}`,
        );
        console.log(
            `   Cross-term duplicates skipped: ${totalCrossTermSkipped}`,
        );
        console.log(
            `   Search observations recorded: ${totalResultObservations}`,
        );
        console.log(
            `   Unique result URLs observed: ${observedUrlsDuringRun.size}`,
        );
        console.log(
            `   New candidates observed: ${totalNewCandidates}`,
        );
        console.log(
            `   Learning run ID: ${runId}`,
        );
        console.log(
            `   Async target crashes recovered: ` +
            `${asynchronousTargetCrashCount}`,
        );
        console.log(
            "============================================================",
        );

        // Wait for Railway's FTN trigger server to confirm that the
        // source table was started, queued, or already running before
        // this cron container is allowed to exit.
        await triggerFtnEnrichment({
            totalInserted,
            totalFailed,
            totalExistingSkipped,
            totalCrossTermSkipped,
        });

        console.log("");
        console.log(
            "✅ Scrape completed. FTN enrichment request was accepted.",
        );
    } catch (error) {
        if (searchRunCreated && !searchRunFinished) {
            await finishSearchRun(
                runId,
                isNextdoorThrottleError(error)
                    ? "throttled"
                    : "failed",
                currentTotals(),
                getErrorMessage(error),
            ).catch((auditError) => {
                console.warn(
                    "⚠️ Could not finalize failed learning run: " +
                    getErrorMessage(auditError),
                );
            });
        }

        throw error;
    } finally {
        console.log("🧹 Closing scraper resources...");

        await closePageSafely(
            bootstrapPage,
            "bootstrap page",
        );

        await pool.end().catch((error) => {
            console.warn(
                `⚠️ Could not close database pool: ${error.message}`,
            );
        });

        if (browser?.isConnected()) {
            // Close the Playwright CDP connection and Multilogin browser.
            await browser.close().catch((error) => {
                console.warn(
                    `⚠️ Could not close Multilogin browser: ${error.message}`,
                );
            });
        }

        console.log("✅ Scraper resources closed.");
    }
}

main()
    .then(async () => {
        console.log(
            "✅ Nextdoor scraper completed successfully.",
        );
        console.log(
            "🛑 Force-terminating scraper process with exit code 0.",
        );

        // Briefly allow final log output to flush.
        await new Promise((resolve) => {
            setTimeout(resolve, 250);
        });

        process.exit(0);
    })
    .catch(async (error) => {
        console.error(
            "❌ Fatal scraper error:",
            error?.stack || error?.message || error,
        );

        await pool.end().catch(() => {});

        process.exit(1);
    });
