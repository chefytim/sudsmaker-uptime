'use strict';
// Brewery Watch — outside watcher. Runs on GitHub Actions every ~5 minutes (public repo
// chefytim/sudsmaker-uptime, which is free), so it still works when the house has no power or
// internet. DMs Tim on Discord once when something goes down and once when it's back.
// Source of truth: brewery-watch/external/ (copy check.js + uptime.yml to that repo to deploy).
//
// Checks (from the internet, like a player):
//   site   - sudsmaker.com loads and its live game data is fresh
//   games  - not EVERY game server shows offline (that means the game hosts are down)
//   watch  - brewery-watch (the in-house monitor) is still running: /status/healthz says "ok"
// State (what's currently down) lives in state.json, carried between runs by actions/cache.

const fs = require('fs');
const { execSync } = require('child_process');

const SITE        = 'https://sudsmaker.com';
const MAX_STALE_M = 20;      // /api/live must have refreshed within this many minutes
const TIMEOUT_MS  = 15000;
const RETRY_MS    = 30000;   // re-check once before calling anything down (ignores blips)
const GAMES_RETRY = 150000;  // > the site's 2-min game poll, so the re-check sees fresh data
const KEEPALIVE_D = 45;      // GitHub pauses cron in public repos after 60 days without commits
const STATE_FILE  = 'state.json';

const TOKEN    = process.env.DISCORD_BOT_TOKEN;
const OWNER_ID = process.env.DISCORD_OWNER_ID || '304054467588915221';
const SIMULATE = process.env.SIMULATE_DOWN || 'none';   // none | site | games | watch

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = url => fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'brewery-watch-external' } });
const why = err => `${err.cause?.code || err.name}: ${err.cause?.message || err.message}`;

// Each probe returns { down: reason } | { up: true, ... } | { unknown: reason }.
async function probeSite() {
  try {
    const home = await get(`${SITE}/`);
    const html = await home.text();
    if (home.status !== 200) return { down: `homepage returned HTTP ${home.status}` };
    if (!html.includes('The Brewery')) return { down: 'homepage loaded but is not the expected page' };
    const live = await get(`${SITE}/api/live`);
    if (live.status !== 200) return { down: `live game data returned HTTP ${live.status}` };
    const data = await live.json();
    const ageM = (Date.now() - new Date(data.updatedAt).getTime()) / 60000;
    if (!(ageM <= MAX_STALE_M)) return { down: `live game data is stale (last update ${data.updatedAt})` };
    return { up: true, live: data };
  } catch (err) {
    return { down: `can't reach it (${why(err)})` };
  }
}

function gamesFrom(live) {
  const t = live?.totals;
  if (!t || !(t.serversTotal > 0)) return { unknown: 'site has no game-server data yet' };
  if (t.serversUp > 0) return { up: true, checkedAt: live.satisfactory?.checkedAt };
  return { down: `all ${t.serversTotal} game servers show offline`, checkedAt: live.satisfactory?.checkedAt };
}

async function checkSite() {
  if (SIMULATE === 'site') return { down: 'simulated (manual test run)' };
  let r = await probeSite();
  if (r.down) { await sleep(RETRY_MS); r = await probeSite(); }
  return r;
}

async function checkGames(site) {
  if (SIMULATE === 'games') return { down: 'simulated (manual test run)' };
  if (!site.up) return { unknown: 'site is down' };
  const first = gamesFrom(site.live);
  if (!first.down) return first;
  await sleep(GAMES_RETRY);
  const again = await probeSite();
  if (!again.up) return { unknown: 'site stopped responding during the re-check' };
  const second = gamesFrom(again.live);
  if (second.down && second.checkedAt === first.checkedAt) return { unknown: 'site has not re-polled yet' };
  return second;
}

async function checkWatch(site) {
  if (SIMULATE === 'watch') return { down: 'simulated (manual test run)' };
  if (!site.up) return { unknown: 'site is down' };
  const probe = async () => {
    try {
      const r = await get(`${SITE}/status/healthz`);
      return r.status === 200 ? { up: true } : { down: `health check says "${(await r.text()).trim()}" (HTTP ${r.status})` };
    } catch (err) { return { down: `health check unreachable (${why(err)})` }; }
  };
  let r = await probe();
  if (r.down) { await sleep(RETRY_MS); r = await probe(); }
  return r;
}

async function dm(text) {
  if (!TOKEN) { console.log('[dm] no DISCORD_BOT_TOKEN secret; would send:\n' + text); return; }
  const api = (path, body) => fetch(`https://discord.com/api/v10${path}`, {
    method: 'POST',
    headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(async r => { if (!r.ok) throw new Error(`Discord HTTP ${r.status}: ${await r.text()}`); return r.json(); });
  const ch = await api('/users/@me/channels', { recipient_id: OWNER_ID });
  await api(`/channels/${ch.id}/messages`, { content: text, allowed_mentions: { parse: [] } });
  console.log('[dm] sent: ' + text.split('\n')[0]);
}

const TARGETS = {
  site:  { down: r => `🔴 **sudsmaker.com is down** (seen from outside): ${r}. If the game servers look down too, suspect a power or internet outage at the house.`,
           up: d => `✅ sudsmaker.com is back (down about ${d}).` },
  games: { down: r => `🔴 **Every game server looks offline** (seen from outside): ${r}. sudsmaker.com itself is up, so check fermenter/taproom.`,
           up: d => `✅ Game servers are back (down about ${d}).` },
  watch: { down: r => `🔴 **Brewery Watch has stopped** (${r}). You won't get in-house alerts until it's running again (pm2 brewery-watch on SudsmakerWebsite).`,
           up: d => `✅ Brewery Watch is running again (stopped about ${d}).` },
};

function duration(sinceIso) {
  const m = Math.round((Date.now() - new Date(sinceIso).getTime()) / 60000);
  return m >= 120 ? `${(m / 60).toFixed(1)} hours` : `${m} minute${m === 1 ? '' : 's'}`;
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
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { console.log('No saved state (first run or cache expired).'); }

  const site = await checkSite();
  const results = { site, games: await checkGames(site), watch: await checkWatch(site) };

  const messages = [];
  for (const [name, r] of Object.entries(results)) {
    const was = state[name];
    if (r.unknown) { console.log(`[${name}] unknown: ${r.unknown}`); continue; }
    console.log(`[${name}] ${r.down ? 'DOWN: ' + r.down : 'up'}`);
    if (r.down && !was?.down) {
      state[name] = { down: true, since: new Date().toISOString() };
      messages.push(TARGETS[name].down(r.down));
    } else if (!r.down && was?.down) {
      messages.push(TARGETS[name].up(duration(was.since)));
      state[name] = { down: false };
    } else if (!r.down) {
      state[name] = { down: false };
    }
  }
  // Save state first so a Discord hiccup can't cause repeat alerts on the next run.
  if (SIMULATE === 'none') fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  if (messages.length) await dm(messages.join('\n'));
  keepalive();
})().catch(err => {
  // Script/API errors fail the run (GitHub emails on failed runs); outages themselves don't.
  console.error(err);
  process.exit(1);
});
