# sudsmaker-uptime

External uptime check for https://sudsmaker.com, run by GitHub Actions every 5 minutes, so it
keeps working when the home lab (server02, Brewhouse) loses power.

Each run checks that:

- the homepage returns 200 and is the real Brewery page (not an error page from the proxy), and
- `/api/live` returns 200 with `updatedAt` less than 20 minutes old (the site's data poller is
  still running).

A failure is re-checked 30 seconds later before it counts, to ignore brief blips.

**Alerts are GitHub issues.** When the site goes down, the workflow opens one issue labelled
`outage` that mentions @chefytim (GitHub emails you and pushes to the GitHub mobile app). When the
site comes back, it comments with how long it was down and closes the issue. The outage history is
the list of closed `outage` issues.

An outage does **not** fail the workflow run (that would email on every run). A failed run means
the checker itself broke.

## Notes

- GitHub's scheduled runs are best-effort: expect runs every 5–15 minutes, not exactly every 5.
- GitHub pauses scheduled workflows in public repos after 60 days without commits, so the
  script pushes an empty "keepalive" commit when the last commit is more than 45 days old.
- Run it by hand: Actions → uptime → Run workflow, or `gh workflow run uptime`.
