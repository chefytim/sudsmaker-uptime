# sudsmaker-uptime — Brewery Watch outside watcher

Runs on GitHub Actions every ~5 minutes, so it still works when The Brewery's home lab has no
power or internet. It DMs the owner on Discord (alert-only bot, token in the `DISCORD_BOT_TOKEN`
repo secret) once when something goes down and once when it recovers:

- **site**: sudsmaker.com loads and its live game data is fresh
- **games**: not every game server shows offline
- **watch**: the in-house monitor (Brewery Watch) reports itself alive at `/status/healthz`

Public only because Actions minutes are free for public repos; there are no secrets in the code.
**Source of truth is `external/` in the private `brewery-watch` repo** — edit there, copy here.
Manual test: Actions → uptime → Run workflow → `simulate_down` (sends a test DM, saves no state).
