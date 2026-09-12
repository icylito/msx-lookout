# MSX Lookout

This is a tool that tracks stocks on the Muscat Stock Exchange (MSX). Anyone interested in MSX listed companies can check prices, browse the market, and look at charts. Saving a watchlist, changing email settings, or running updates needs an operator key — regular visitors can read, not write.

![Terminal view](docs/image-1.png)

## How it works

how it works diagram 

![How it works](docs/how-it-works.svg)

Every trading day (Sunday - Thursday, right after MSX closes, emails usually go out around 5pm) it pulls that day's prices for every listed stock from MSX's own site. Saves them in a database, nothing gets overwritten, so the history just keeps growing and you can look at older prices later.

It checks any alerts you set, like tell me if BKMB drops below 1.400, and emails a heads-up if one got crossed. There's a daily summary too. Top gainers/losers, volume, an excel snapshot attached so you can see the day without opening the app. That email thing might not stay free forever because a real domain is like $10/year if you want it looking proper. You can just leave it off.

It also watches MSX announcements for splits, dividends, new listings, and files them against the right company.

Two years of history (mid-2024 onward) was pulled in already so "did I buy at a fair price?" works for older positions, not only stuff bought after this started.

## The app

One web page (`web/index.html`) is the front door. No login. Prices, browse, compare, and charts are open to read. Changing the shared watchlist, digest email, or kicking off an ingest needs the operator key in Settings (same value as the server ingest secret; it stays on that device). Offline reads still work from the last successful load.

![The app](docs/image.png)

My stocks is the watchlist. What's held, today's price, day change, gain/loss in actual money.

Browse is every listed company not just yours. Filter by name, ticker, sector. There's a flag for anything that's gone quiet or never traded, mostly stocks under liquidation.

Click a stock to add a position. What you bought, at what price, on what date. It checks that price against the history and tells you if it looks right, close, or off, but it never blocks you from saving anyway.

Alerts / emails. Optional notify me when you're adding a position. These are end of day notices, not trade orders. A stock alert isn't a broker order.

Charts. Candles or area, volume, some drawing tools, trend lines, fibonacci, that kind of thing. Compare is two time periods, this week vs last, whatever, and what moved. There's suggestions like 1 day, 1 week, 1 month.

Download excel from settings. Past exports sit in settings too.

Settings is the gear. Light/dark/system, a display name, how often prices and companies refresh, and which emails you want.

```
1 - all email notifications     # as the name says, every email we send
2 - new listings and delistings # a company joined MSX or left, you'd know
3 - update failure alerts       # if the updater keeps failing so it isn't silent
```

Put the address in settings / general. Empty field means don't send. Master switch off also means don't send, including the failure ones.

If MSX is down the app says so and shows the last confirmed price with a timestamp. It doesn't pretend nothing's wrong.

Offline is basic. Whatever it last loaded is saved on the device so a bad connection shows old data rather than nothing, with a last synced note so you know when you last got a real pull. Writes queue on the device and go out when you're back.

It's a Windows app too, Tauri, same page, self updating from github releases when there's a release up.

## Where everything lives

Database is one Supabase project. Prices, companies, watchlist, alerts, all in there.

The daily jobs (ingest prices, digest, alerts, company refresh, weekly backup) are Edge Functions on a schedule. No extra servers, everything in one place. How often prices vs companies vs digest run is a setting in the app, daily/weekly/monthly/never, your choice, not hardcoded.

The web page is one static html file. GitHub Pages can host it.

Emails go through Resend. Pick the address in settings and pick what you actually want.

## Status

Works. Hop in, try it. Leave an issue if something's off. Fork it if you want your own. PRs are fine, just leave a message on it.

Windows installer goes on github releases when I put one up. Until then `cargo tauri dev` is the window. Expect some edge cases, it's not fully clean. If something breaks make an issue and I'll deal with it, and I'll update this file if a big one got fixed.
