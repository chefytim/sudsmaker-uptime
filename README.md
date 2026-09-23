# sudsmaker-uptime

External uptime checks for https://sudsmaker.com and Brewhouse, run by GitHub Actions every 5
minutes, so they keep working when the home lab (server02, Brewhouse) loses power.

## sudsmaker.com

Each run checks that:

- the homepage returns 200 and is the real Brewery page (not an error page from the proxy), and
- `/api/live` returns 200 with `updatedAt` less than 20 minutes old (the site's data poller is
  still running).

A failure is re-checked 30 seconds later before it counts, to ignore brief blips.

## Brewhouse

Brewhouse (10.10.50.12) has no public address, so it's judged from the site's own view of it:
the site polls every game server on Brewhouse, and when it can't reach Brewhouse they **all**
show offline. So Brewhouse counts as down when sudsmaker.com is up but **every** game server in
`/api/live` is offline (one or two stopped servers is normal and doesn't alert). Before alerting,
it waits 2½ minutes for the site's next Satisfactory poll and confirms everything is still offline.

If sudsmaker.com itself is down, Brewhouse is reported as "unknown": no new issue, and an
open Brewhouse issue is left open until the site can see Brewhouse again.

## Alerts

**Alerts are GitHub issues.** When a target goes down, the workflow opens one issue (labelled
`sudsmaker.com` or `brewhouse`, plus `outage`) that mentions @chefytim (GitHub emails you and pushes to the GitHub mobile app). When it
comes back, it comments with how long it was down and closes the issue. The outage history is
the list of closed `outage` issues.

An outage does **not** fail the workflow run (that would email on every run). A failed run means
the checker itself broke.

## Notes

- GitHub's scheduled runs are best-effort: expect runs every 5–15 minutes, not exactly every 5.
- GitHub pauses scheduled workflows in public repos after 60 days without commits, so the
  script pushes an empty "keepalive" commit when the last commit is more than 45 days old.
- Run it by hand: Actions → uptime → Run workflow, or `gh workflow run uptime`.
- Test an alert: run it with **simulate_down** set to `site` or `brewhouse`
  (`gh workflow run uptime -f simulate_down=brewhouse`) to open a test issue, then run it
  normally to close it again.
