'use strict';
// External uptime check for sudsmaker.com, run by GitHub Actions every 5 minutes.
// Opens one GitHub issue (label "outage") when the site goes down and closes it
// when the site recovers, so each outage produces one "down" and one "recovered"
// notification instead of one per run.

const { execSync } = require('child_process');

const SITE        = 'https://sudsmaker.com';
const MAX_STALE_M = 20;       // /api/live must have refreshed within this many minutes
const TIMEOUT_MS  = 15000;
const RETRY_MS    = 30000;    // re-check once before declaring an outage (ignores blips)
const LABEL       = 'outage';
const OWNER       = 'chefytim';
const KEEPALIVE_D = 45;       // GitHub pauses cron in public repos after 60 days without commits

const REPO  = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;

async function get(url) {
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'sudsmaker-uptime' } });
}

// Returns null when healthy, or a short reason string when not.
let checkOnce = async function checkOnce() {
  try {
    const home = await get(`${SITE}/`);
    const html = await home.text();
    if (home.status !== 200) return `homepage returned HTTP ${home.status}`;
    if (!html.includes('The Brewery')) return 'homepage returned 200 but not the expected page';

    const live = await get(`${SITE}/api/live`);
    if (live.status !== 200) return `/api/live returned HTTP ${live.status}`;
    const data = await live.json();
    const ageM = (Date.now() - new Date(data.updatedAt).getTime()) / 60000;
    if (!(ageM <= MAX_STALE_M)) return `/api/live data is stale (updatedAt ${data.updatedAt})`;

    return null;
  } catch (err) {
    return `request failed: ${err.cause?.code || err.name}: ${err.cause?.message || err.message}`;
  }
};

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
  if (process.env.SIMULATE_DOWN === 'true') {
    console.log('SIMULATE_DOWN set: treating the site as down.');
    checkOnce = async () => 'simulated outage (manual test run)';
  }
  let reason = await checkOnce();
  if (reason) {
    console.log(`First check failed (${reason}); retrying in ${RETRY_MS / 1000}s.`);
    await new Promise(r => setTimeout(r, RETRY_MS));
    reason = await checkOnce();
  }
  console.log(reason ? `DOWN: ${reason}` : 'UP');

  const open = await gh('GET', `/issues?state=open&labels=${LABEL}&per_page=1`);
  const issue = open[0];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  if (reason && !issue) {
    const created = await gh('POST', '/issues', {
      title: `🔴 sudsmaker.com is DOWN (since ${now})`,
      labels: [LABEL],
      body:
        `@${OWNER} ${SITE} failed two checks 30 seconds apart.\n\n` +
        `**Reason:** ${reason}\n\n` +
        `If Brewhouse and server02 went down together, suspect a power interruption at home.\n\n` +
        `This issue will be closed automatically when the site recovers.`,
    });
    console.log(`Opened issue #${created.number}.`);
  } else if (!reason && issue) {
    const mins = Math.round((Date.now() - new Date(issue.created_at).getTime()) / 60000);
    const dur  = mins >= 120 ? `${(mins / 60).toFixed(1)} hours` : `${mins} minutes`;
    await gh('POST', `/issues/${issue.number}/comments`, {
      body: `🟢 @${OWNER} ${SITE} is back up as of ${now}. Down for about ${dur} (as seen from GitHub).`,
    });
    await gh('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
    console.log(`Closed issue #${issue.number} after ~${dur}.`);
  } else if (issue) {
    console.log(`Still down; issue #${issue.number} already open.`);
  }

  keepalive();
})().catch(err => {
  // Script/API errors fail the run (GitHub emails on failed runs); outages themselves do not.
  console.error(err);
  process.exit(1);
});
