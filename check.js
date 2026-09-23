'use strict';
// External uptime checks for The Brewery, run by GitHub Actions every 5 minutes.
// Each check opens one GitHub issue when its target goes down and closes it when
// the target recovers, so each outage produces one "down" and one "recovered"
// notification instead of one per run.

const { execSync } = require('child_process');

const SITE          = 'https://sudsmaker.com';
const MAX_STALE_M   = 20;     // /api/live must have refreshed within this many minutes
const TIMEOUT_MS    = 15000;
const SITE_RETRY_MS = 30000;  // re-check once before declaring an outage (ignores blips)
const BREW_RETRY_MS = 150000; // > the site's 2-min Satisfactory poll, so the re-check sees fresh data
const OWNER         = 'chefytim';
const KEEPALIVE_D   = 45;     // GitHub pauses cron in public repos after 60 days without commits

const REPO     = process.env.GITHUB_REPOSITORY;
const TOKEN    = process.env.GITHUB_TOKEN;
const SIMULATE = process.env.SIMULATE_DOWN || 'none'; // none | site | brewhouse

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'sudsmaker-uptime' } });
}

// Each check returns { down: reason } | { up: true } | { unknown: reason }.

async function probeSite() {
  try {
    const home = await get(`${SITE}/`);
    const html = await home.text();
    if (home.status !== 200) return { down: `homepage returned HTTP ${home.status}` };
    if (!html.includes('The Brewery')) return { down: 'homepage returned 200 but not the expected page' };

    const live = await get(`${SITE}/api/live`);
    if (live.status !== 200) return { down: `/api/live returned HTTP ${live.status}` };
    const data = await live.json();
    const ageM = (Date.now() - new Date(data.updatedAt).getTime()) / 60000;
    if (!(ageM <= MAX_STALE_M)) return { down: `/api/live data is stale (updatedAt ${data.updatedAt})` };

    return { up: true, live: data };
  } catch (err) {
    return { down: `request failed: ${err.cause?.code || err.name}: ${err.cause?.message || err.message}` };
  }
}

// Brewhouse has no public address, so it's judged from the site's own view of it:
// when the site can't reach Brewhouse, every game server it lists shows offline.
// One or two servers being off is normal; *all* of them off means Brewhouse is down.
function brewhouseFrom(live) {
  const t = live?.totals;
  if (!live?.satisfactory || !live?.games || !t || !(t.serversTotal > 0)) {
    return { unknown: 'site has no game-server data yet' };
  }
  if (t.serversUp > 0) return { up: true, checkedAt: live.satisfactory.checkedAt };
  return { down: `all ${t.serversTotal} game servers show offline on sudsmaker.com`, checkedAt: live.satisfactory.checkedAt };
}

async function checkSite() {
  if (SIMULATE === 'site') return { down: 'simulated outage (manual test run)' };
  let r = await probeSite();
  if (r.down) {
    console.log(`[site] First check failed (${r.down}); retrying in ${SITE_RETRY_MS / 1000}s.`);
    await sleep(SITE_RETRY_MS);
    r = await probeSite();
  }
  return r;
}

async function checkBrewhouse(site) {
  if (SIMULATE === 'brewhouse') return { down: 'simulated outage (manual test run)' };
  if (!site.up) return { unknown: 'sudsmaker.com is down, so Brewhouse cannot be judged' };
  const first = brewhouseFrom(site.live);
  if (!first.down) return first;

  console.log(`[brewhouse] ${first.down}; waiting ${BREW_RETRY_MS / 1000}s for a fresh poll.`);
  await sleep(BREW_RETRY_MS);
  const again = await probeSite();
  if (!again.up) return { unknown: 'sudsmaker.com stopped responding during the re-check' };
  const second = brewhouseFrom(again.live);
  if (second.down && second.checkedAt === first.checkedAt) {
    return { unknown: 'site has not re-polled the game servers yet' };
  }
  return second;
}

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sudsmaker-uptime',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Open/close the issue for one target based on its result.
async function reconcile({ name, label, hint }, result) {
  const open  = await gh('GET', `/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`);
  const issue = open[0];
  const now   = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  if (result.unknown) {
    console.log(`[${label}] UNKNOWN: ${result.unknown}${issue ? ` (issue #${issue.number} left as is)` : ''}`);
    return;
  }
  console.log(`[${label}] ${result.down ? `DOWN: ${result.down}` : 'UP'}`);

  if (result.down && !issue) {
    const created = await gh('POST', '/issues', {
      title: `🔴 ${name} is DOWN (since ${now})`,
      labels: [label, 'outage'],
      body:
        `@${OWNER} ${name} failed its check.\n\n` +
        `**Reason:** ${result.down}\n\n${hint}\n\n` +
        `This issue will be closed automatically when it recovers.`,
    });
    console.log(`[${label}] Opened issue #${created.number}.`);
  } else if (!result.down && issue) {
    const mins = Math.round((Date.now() - new Date(issue.created_at).getTime()) / 60000);
    const dur  = mins >= 120 ? `${(mins / 60).toFixed(1)} hours` : `${mins} minute${mins === 1 ? '' : 's'}`;
    await gh('POST', `/issues/${issue.number}/comments`, {
      body: `🟢 @${OWNER} ${name} is back up as of ${now}. Down for about ${dur} (as seen from GitHub).`,
    });
    await gh('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
    console.log(`[${label}] Closed issue #${issue.number} after ~${dur}.`);
  } else if (issue) {
    console.log(`[${label}] Still down; issue #${issue.number} already open.`);
  }
}

function keepalive() {
  const last = Number(execSync('git log -1 --format=%ct').toString().trim()) * 1000;
  if (Date.now() - last < KEEPALIVE_D * 86400000) return;
  execSync('git config user.name "github-actions[bot]"');
  execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  execSync('git commit --allow-empty -m "Keepalive: prevent GitHub from pausing the schedule"');
  execSync('git push');
  console.log('Pushed keepalive commit.');
}

(async () => {
  if (SIMULATE !== 'none') console.log(`SIMULATE_DOWN=${SIMULATE}: treating it as down.`);

  const site = await checkSite();
  await reconcile({
    name: 'sudsmaker.com', label: 'sudsmaker.com',
    hint: 'If Brewhouse is unreachable too, suspect a power or internet interruption at home.',
  }, site);

  const brew = await checkBrewhouse(site);
  await reconcile({
    name: 'Brewhouse', label: 'brewhouse',
    hint: 'sudsmaker.com itself is up, so server02 is fine; the problem is Brewhouse ' +
          '(10.10.50.12) or its Docker/game servers.',
  }, brew);

  keepalive();
})().catch(err => {
  // Script/API errors fail the run (GitHub emails on failed runs); outages themselves do not.
  console.error(err);
  process.exit(1);
});
