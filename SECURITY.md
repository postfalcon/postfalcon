# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately on GitHub
instead: go to the repository's **Security** tab and choose **Report a vulnerability**
([direct link](https://github.com/postfalcon/postfalcon/security/advisories/new)). Only the
maintainers can see the report.

It helps to include:

- what an attacker could do, and what they need first (an account, an API token, admin rights, nothing)
- the steps or a request that shows it
- the version or commit (Admin → Overview → Version shows both), and whether it's a Docker or
  source install

Postfalcon is maintained by one person, so replies aren't instant, but every report is read.
You'll get an answer within a few days saying whether the problem is confirmed and what happens
next. Once a fix is released, the advisory is published and you're credited, unless you'd
rather not be.

## What's covered

- This repository: the app, the Docker image (`ghcr.io/postfalcon/postfalcon`), `install.sh`
  and the files under `deploy/`.
- The hosted service at [postfalcon.co](https://postfalcon.co). When testing it, use only
  accounts you created yourself, don't read or change other people's data, and don't run load
  or denial-of-service tests.

Not covered: problems that need the attacker to already control the server or its `.env`,
findings from automated scanners with no working example, and missing security headers or
rate limits that don't lead to a real attack.

## Supported versions

Fixes go into `main` and the next release. Only the latest release gets them, so keep your
install updated (README → Updates, data and backups).
