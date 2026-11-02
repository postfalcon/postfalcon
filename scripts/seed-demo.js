// node scripts/seed-demo.js — fills a DEV database with a demo account for screenshots: a made-up
// café ("Northside Roasters") with five fake channels, four weeks of scheduled posts and a month
// of already-posted ones with engagement numbers. A CLI script, so it logs with console.
//
// Safe to re-run: it deletes the demo user (and with it, everything it owns) and starts over.
// Nothing here can publish: the channels hold fake tokens, every scheduled post is in the future,
// and the posted ones have no platform_post_id, so the metrics refresh skips them too.
//
// Times are wall-clock times in DEMO_TZ (default: this machine's timezone), e.g.
//   DEMO_TZ=Australia/Sydney node scripts/seed-demo.js
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

const EMAIL = 'demo@northside.example';
const PASSWORD = 'northside-demo';
const TZ = process.env.DEMO_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

if (process.env.NODE_ENV === 'production' || /postfalcon\.co/.test(process.env.BASE_URL || '')) {
  console.error('Refusing to run: this looks like production. Demo data is for a dev database only.');
  process.exit(1);
}

const { pool } = await import('../db/pool.js');

const CHANNELS = {
  instagram: { name: 'northsideroasters', id: 'demo-ig' },
  facebook: { name: 'Northside Roasters', id: 'demo-fb' },
  threads: { name: '@northsideroasters', id: 'demo-threads' },
  bluesky: { name: 'northsideroasters.bsky.social', id: 'demo-bsky' },
  mastodon: { name: '@northside@mastodon.social', id: 'demo-masto', metadata: { instance: 'mastodon.social' } },
};

// [day offset from today, 'HH:MM', text, channels]
const SCHEDULED = [
  [1, '08:00', '☕ New single origin this week: Ethiopia Guji, notes of peach and jasmine. Limited bags, first in best dressed.', ['instagram', 'facebook', 'bluesky']],
  [1, '07:00', 'Morning fuel: flat whites are $4 until 10am. See you at the counter.', ['facebook', 'threads']],
  [3, '12:00', 'Behind the roaster: how we profile a new bean in 5 steps, from first crack to the cupping table.', ['instagram']],
  [4, '09:00', "We're hiring a part-time barista. Weekends, good coffee, great team. DM us or drop in with your CV.", ['facebook']],
  [5, '15:00', 'Latte art week 🎨 Tag us in your best pour and we’ll share our favourites on the weekend.', ['instagram', 'threads']],
  [7, '10:00', "Our oat milk is now made in-house. Here's why we switched, and what it means for your flat white.", ['bluesky', 'mastodon', 'threads']],
  [9, '18:00', '5 ways to brew better coffee at home (no fancy gear needed). Number 3 is free and takes ten seconds.', ['facebook']],
  [11, '07:30', 'Rainy day special: any pastry + filter coffee for $8. Umbrellas welcome at the door.', ['instagram', 'facebook']],
  [12, '13:00', 'Meet Sam, our head roaster: 12 years in, and still obsessed with getting the last 2% right.', ['instagram']],
  [14, '09:00', 'Weekend cupping session: taste 4 coffees side by side, 10am this weekend. Free, but bring your opinions.', ['facebook', 'mastodon']],
  [16, '16:00', "This week's playlist is up 🎶 Here's what we're grinding to.", ['threads', 'bluesky']],
  [18, '08:00', 'Fresh roast drop: 250 g bags are back in stock online and in the shop.', ['instagram', 'facebook']],
  [20, '11:00', 'Thank you for 10,000 cups this year 💛 Every one of them made by hand, every one of them for you.', ['instagram', 'facebook', 'threads', 'bluesky']],
  [23, '08:00', 'Cold brew is back for spring. Steeped 18 hours, served over ice, gone by 2pm most days.', ['instagram']],
  [26, '10:00', 'Coffee subscription: fresh beans at your door every fortnight. Pause or skip any time.', ['facebook', 'bluesky']],
];

// [days ago, 'HH:MM', text, channel, views, likes, comments, shares]. Mastodon and Bluesky don't
// report views (see their fetchMetrics), so those stay null, as they would for real.
const POSTED = [
  [27, '08:00', 'Our new house blend is here: chocolate, hazelnut and a little bit of orange peel.', 'instagram', 4210, 312, 28, 14],
  [25, '09:30', 'Open from 6:30am on weekdays from today. Early birds, this one is for you.', 'facebook', 2860, 141, 19, 22],
  [23, '12:00', 'What does "single origin" actually mean? A short thread 🧵', 'threads', 1940, 96, 17, 11],
  [21, '10:00', "We've switched to compostable cups. Here's what changed behind the counter.", 'bluesky', null, 188, 24, 41],
  [19, '08:00', 'Saturday market stall is back: find us next to the bakery, 8am to noon.', 'facebook', 3320, 205, 31, 37],
  [17, '15:00', 'Pour-over masterclass recap: thank you to everyone who came along ☕', 'instagram', 5120, 447, 39, 18],
  [14, '11:00', 'Roast day smells like this. (We wish you could smell this.)', 'instagram', 6890, 602, 51, 26],
  [12, '10:00', 'Hot take: the best coffee is the one you drink with someone.', 'mastodon', null, 74, 12, 29],
  [10, '08:30', 'New pastry partner: croissants from Ferrero Street Bakery, every morning from 7.', 'facebook', 4105, 268, 44, 31],
  [8, '13:00', 'How we pick a new green coffee: 30 samples, 4 tastings, 1 winner.', 'threads', 2470, 133, 21, 15],
  [6, '09:00', 'Coffee + community: our wall is now open to local artists. First show opens this week.', 'bluesky', null, 221, 33, 52],
  [4, '08:00', 'Flat white, piccolo or long black? Settle it in the comments 👇', 'instagram', 7340, 518, 167, 22],
  [2, '16:00', 'Sold out of the Guji in two days. More on the way, promise.', 'facebook', 2980, 176, 38, 12],
];

// The UTC instant for a wall-clock time in TZ, `days` from today.
function at(days, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  const guess = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + days, h, m);
  const shown = new Date(new Date(guess).toLocaleString('en-US', { timeZone: TZ }) + ' UTC').getTime();
  return new Date(guess - (shown - guess));
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('DELETE FROM users WHERE email = $1', [EMAIL]);

  const { rows: [user] } = await client.query(
    `INSERT INTO users (email, password_hash, email_verified_at, plan, plan_status, is_admin,
                        onboarding_dismissed_at, admin_setup_dismissed_at)
     VALUES ($1, $2, now(), 'pro', 'active', true, now(), now())
     RETURNING id`,
    [EMAIL, await bcrypt.hash(PASSWORD, 10)]
  );

  const accountIds = {};
  for (const [platform, c] of Object.entries(CHANNELS)) {
    const { rows } = await client.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, metadata)
       VALUES ($1, $2, $3, $4, 'demo-not-a-real-token', $5) RETURNING id`,
      [user.id, platform, c.name, c.id, JSON.stringify(c.metadata ?? {})]
    );
    accountIds[platform] = rows[0].id;
  }

  for (const [days, time, content, channels] of SCHEDULED) {
    const group = channels.length > 1 ? crypto.randomUUID() : null;
    for (const platform of channels) {
      await client.query(
        `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for, crosspost_group_id)
         VALUES ($1, $2, $3, 'scheduled', $4, $5)`,
        [user.id, accountIds[platform], content, at(days, time), group]
      );
    }
  }

  for (const [daysAgo, time, content, platform, views, likes, comments, shares] of POSTED) {
    const when = at(-daysAgo, time);
    await client.query(
      `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for, posted_at,
                          metric_views, metric_likes, metric_comments, metric_shares, metrics_updated_at,
                          created_at, updated_at)
       VALUES ($1, $2, $3, 'posted', $4, $4, $5, $6, $7, $8, now(), $4, $4)`,
      [user.id, accountIds[platform], content, when, views, likes, comments, shares]
    );
  }

  await client.query('COMMIT');
  console.log(`Demo account ready (times in ${TZ}).`);
  console.log(`  Log in as ${EMAIL} / ${PASSWORD}`);
  console.log(`  ${Object.keys(CHANNELS).length} channels, ${SCHEDULED.length} scheduled posts, ${POSTED.length} posted with metrics.`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error(`Seeding failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
