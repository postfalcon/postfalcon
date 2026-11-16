---
title: "Self-Host a Social Media Scheduler with Docker in a Few Minutes"
slug: self-host-a-social-media-scheduler-with-docker
description: "Run your own social media scheduler on a small Linux server: one install command, about 100 MB of memory, automatic HTTPS, and an admin page so you rarely need to log in to the server."
date: 2026-12-09
author: nathan
tags: ["Guides", "Open Source"]
heroGradient: ["#1e293b", "#475569"]
---

Postfalcon is open source, and the version on postfalcon.co is the same code you can run
yourself. This guide goes from an empty server to your first scheduled post. If you're wondering
*why* you'd want to, that's covered in
[why we built Postfalcon to be self-hostable](/blog/why-self-host-your-social-media-scheduler).

## What you need

- **A Linux server**, x86 or ARM. The app uses about 100 MB of memory at rest, so a small 1 GB
  cloud server is enough.
- **A domain or subdomain** pointing at the server, such as `social.example.com`. Ports 80 and
  443 need to be open so HTTPS works.
- **Docker.** If the server doesn't have it, the installer offers to install it.

You don't need to set up a database, a web server or certificates. They're included.

## Install with one command

Log in to the server and run:

```bash
curl -fsSL https://postfalcon.co/install.sh | sh
```

It asks for your domain, generates passwords, and starts three containers: the app, a Postgres
database and Caddy, which gets the HTTPS certificate on its own. Everything lives in
`~/postfalcon`, and nothing else on the machine is changed.

Prefer to read a script before running it? Download it first:

```bash
curl -fsSL https://postfalcon.co/install.sh -o install.sh
less install.sh
sh install.sh
```

## Create the admin account straight away

When the installer finishes, open the address it prints and choose **Sign up**. **The first
account on a new install becomes the admin**, so do this before anyone else can reach the server.

## Set it up from the admin page

Most of the setup that other self-hosted apps do in config files happens in the browser here.
Under **Admin → Overview** you'll find a checklist of anything not set up yet:

- **Sign-ups:** open, invite-only (with one-time invite links) or closed.
- **Email:** add your mail server's details and send a test message, so password resets and
  alerts arrive.
- **Backups:** the database is backed up every night, and you can list, download or make one
  on the spot.
- **Alerts:** you get an email if posts stop going out, a platform starts failing, or backups go
  stale.

## Connecting social platforms

**Mastodon, Bluesky and Telegram work straight away**: they need no developer app, so you can
connect them and schedule a post within minutes.

The other platforms (Threads, LinkedIn, Pinterest, YouTube, TikTok, Facebook, Instagram) each
require *your own* developer app with that platform, because their rules tie posting access to
an app registered by whoever runs the server. **Admin → Platforms** walks through each one: where
to create the app, which callback address to paste in, and which keys to add. Some platforms
review apps before they allow posting, which can take a while.

## Keeping it updated

From the install folder:

```bash
cd ~/postfalcon
docker compose pull
docker compose up -d
```

The admin page shows the version you're running and tells you when there's a newer one.

## Not keen on running a server?

That's what [postfalcon.co](/) is for: the same app, run for you. Mastodon, Bluesky and Telegram
are free there too. Either way, the code is on
[GitHub](https://github.com/postfalcon/postfalcon), and if Postfalcon is useful to you, a star
there helps other people find it.
