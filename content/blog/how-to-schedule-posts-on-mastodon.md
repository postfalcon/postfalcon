---
title: "How to Schedule Posts on Mastodon"
slug: how-to-schedule-posts-on-mastodon
description: "Schedule Mastodon posts on any instance: connect with your instance's own login, write with alt text and hashtags that work, and send the same post to Bluesky too. Free on Postfalcon."
date: 2026-11-25
author: nathan
tags: ["Guides", "Platforms"]
heroGradient: ["#563acc", "#8c8dff"]
---

Mastodon has no algorithm deciding when people see your posts: they show up in followers'
timelines in the order they're posted. That makes timing matter, and it's why scheduling helps.
Write when you have time, publish when your followers are awake. Here's how to do it with
Postfalcon. Scheduling to Mastodon is free on postfalcon.co, with no card needed.

## Connect your Mastodon account

Mastodon is made of many separate servers (instances), so the first thing Postfalcon needs is
which one you're on.

1. [Sign up](/signup) (or log in) and open **Accounts**.
2. In the **Mastodon** card, type your instance's domain, for example `mastodon.social`,
   `fosstodon.org` or `hachyderm.io`. Just the domain, without `https://` or your username.
3. Click **Connect Mastodon**. You're sent to your own instance's login page, where you approve
   access, and then come back with the account connected.

Postfalcon never sees your Mastodon password, only the access your instance grants it. You can
revoke it any time from your instance's settings, under **Authorized apps**.

## Schedule a post

1. On the **Dashboard**, click a day on the calendar (or **New post**).
2. Pick your Mastodon account and write the post. The counter checks against **500
   characters**, the standard Mastodon limit.
3. Attach up to **4 images**, and give each one alt text. On Mastodon this matters: many people
   rely on it, and plenty of others won't boost an image that doesn't have it.
4. Choose a date and time, then **Schedule**.

At that time Postfalcon posts it to your instance, and it appears exactly like a post you wrote
in the app.

## Hashtags work differently here

With no algorithm, hashtags are how new people find your posts: people follow tags, and tag
searches are how most discovery happens. A few habits that help:

- **Use one to three tags** that people actually follow, rather than a long list.
- **Write them in CamelCase**: `#SelfHosted`, not `#selfhosted`. Screen readers read each word
  instead of spelling out one long blur, and it's easier for everyone to read.
- **Put them at the end** unless a tag reads naturally inside the sentence.

## When to post

Look at when your own followers reply and boost, since that beats any general chart. If your
followers span time zones, scheduling is what lets you reach the ones who are awake while
you're asleep.

## Send it to Bluesky too

If you're on Bluesky as well, connect it, tick both accounts in the composer, and the one post
goes to each. Bluesky's limit is 300 characters, so the composer checks each platform's limit
separately and tells you if one is over. See
[cross-posting](/blog/cross-posting-to-multiple-platforms), or the
[Bluesky scheduling guide](/blog/how-to-schedule-posts-on-bluesky).

## What it costs

Mastodon, Bluesky and Telegram are free on postfalcon.co for up to 5 accounts across the three,
including cross-posting and repeating posts. Postfalcon is open source too, so if you'd rather
[host it yourself](https://github.com/postfalcon/postfalcon) (some instance admins do), you can.

[Start scheduling Mastodon posts →](/signup)
