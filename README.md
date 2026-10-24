# Fluxer Free Games Bot

A small [Fluxer](https://fluxer.app) bot that announces games which are currently **free to keep** (price dropped to 0) on the stores you choose, using the [CheapShark](https://www.cheapshark.com) API. It posts each new giveaway as a rich embed with a preview image, pings a role of your choice, and answers commands on demand.

- Polls CheapShark every 60 minutes by default (configurable, clamped to 15 minutes to 24 hours)
- Announces only games it hasn't announced before, and remembers them across restarts
- Choose stores by name or CheapShark ID, or announce all of them
- Mention a role, `@everyone`, `@here`, or nobody
- Announce in several channels, even across communities, each with its own role ping
- Prefix commands: `!free`, `!free <store>`, `!stores`, `!help`, plus `!subscribe`, `!unsubscribe`, `!channels` and `!reload` for admins
- Runs in a ~70 MB Alpine container capped at 128 MB RAM

Built on the same libraries the [official Fluxer quickstart](https://docs.fluxer.app/quickstart) uses (`@discordjs/core`, `@discordjs/rest`, `@discordjs/ws`), since Fluxer's API is Discord-compatible. Fluxer does not support slash commands yet, so commands use a prefix.

## Quick start

1. **Create the bot in Fluxer.** Create an application, copy its bot token (`{application_id}.{secret}`) and invite the bot with the URL from [Inviting the bot](#inviting-the-bot).
2. **Pick the channels.** Either put channel IDs in `FLUXER_CHANNELS`, or leave it empty and run `!subscribe` in each channel later.
3. **Configure and start:**

   ```sh
   git clone https://github.com/NoBrainFox/fluxer-free-games.git
   cd fluxer-free-games
   cp .env.example .env    # then fill in FLUXER_BOT_TOKEN, FLUXER_CHANNELS, CONTACT_EMAIL, STORES
   docker compose up -d --build
   docker compose logs -f
   ```

To update later: `git pull && docker compose up -d --build`.

## Inviting the bot

Open this URL with your application ID filled in and pick your community:

```
https://fluxer.app/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=84992
```

The only scope needed is `bot`. `84992` grants:

| Permission | Value | Why |
| --- | --- | --- |
| View Channel | 1024 | See the announcement channel and command messages |
| Send Messages | 2048 | Post announcements and command replies |
| Embed Links | 16384 | Show the game embeds with preview images |
| Read Message History | 65536 | Reply to command messages, and find old posts for `!reload` |

If a channel pings `everyone` or `here`, or the role you ping isn't set to be mentionable by everyone, also grant **Mention @everyone, @here and All Roles** (131072) by using `permissions=216064` instead. No admin rights and no extra gateway intents are needed.

## Configuration

Everything is set in `.env`.

| Variable | Default | Description |
| --- | --- | --- |
| `FLUXER_BOT_TOKEN` | *(required)* | Bot token from Fluxer |
| `FLUXER_CHANNELS` | *(empty)* | Channels for automatic announcements, comma separated, each optionally followed by `:` and the role to ping, e.g. `111111:Free Games,222222:everyone,333333`. A role can be a name or ID, `everyone`, `here`, or left out for no ping. The ping is sent once per batch of new games. Channels added with `!subscribe` are added to these |
| `FLUXER_CHANNEL_ID` | *(empty)* | Older single-channel setting, still supported. Added to `FLUXER_CHANNELS` |
| `CONTACT_EMAIL` | *(recommended)* | Your contact email, sent in the User-Agent of CheapShark requests so CheapShark can reach you if the bot misbehaves |
| `MENTION_ROLE` | *(empty)* | Role to ping in `FLUXER_CHANNEL_ID`, for older setups |
| `STORES` | `Steam,GOG,Epic Games Store` | Comma separated CheapShark store names or IDs, or `all`. Partial names work (`epic`) |
| `POLL_INTERVAL_MINUTES` | `60` | How often to check CheapShark. Values outside 15 to 1440 are clamped |
| `INCLUDE_FREE_TO_PLAY` | `false` | Also announce permanently free-to-play games |
| `POST_ON_FIRST_RUN` | `true` | On the very first start, announce games that are already free. Set to `false` to only announce future giveaways |
| `SHOW_END_DATES` | `true` | Add a "Free until" field with the offer's end date, when one can be found |
| `END_DATE_STYLE` | `discord` | `discord` shows `<t:…>` timestamps (local time plus a live countdown); `text` shows a plain UTC date if your client doesn't render them |
| `DELETE_EXPIRED_POSTS` | `false` | Delete an announcement once the game is no longer free. Works for posts made by this version or later |
| `DELETE_GRACE_MINUTES` | `120` | How long a game has to be missing from the free list before its post is deleted (minimum 15) |
| `COMMAND_PREFIX` | `!` | Prefix for commands |
| `COMMAND_COOLDOWN_SECONDS` | `10` | Minimum time between commands per channel |
| `FLUXER_API_URL` | `https://api.fluxer.app` | API base URL, the part before `/v1`. Set it for a self-hosted Fluxer instance, see below |
| `FLUXER_API_VERSION` | `1` | Fluxer API version |
| `FLUXER_GATEWAY_URL` | *(from the API)* | Overrides the gateway URL the API advertises. Only needed if your instance advertises the wrong one |
| `FLUXER_GATEWAY_INTENTS` | `0` | Gateway intents bitfield (the official docs use 0) |

Common CheapShark store IDs: `1` Steam, `3` GreenManGaming, `7` GOG, `11` Humble Store, `13` Ubisoft, `15` Fanatical, `25` Epic Games Store. Run `!stores` in Fluxer for the full, current list.

## Commands

| Command | What it does |
| --- | --- |
| `!free` | Lists free games on the configured stores |
| `!free <store>` | Lists free games on one store, e.g. `!free gog` |
| `!free all` | Lists free games on every store |
| `!stores` | Shows all CheapShark stores and which ones are announced |
| `!help` | Shows the command list |

These commands only work for the community owner and for members with the **Manage Server** or **Administrator** permission:

| Command | What it does |
| --- | --- |
| `!subscribe [role]` | Announces new free games in this channel and posts the ones that are free right now. The optional role (a mention, name or ID, `everyone` or `here`) is pinged with each batch. Run it again to change the role |
| `!unsubscribe` | Stops announcements in this channel. Existing posts stay |
| `!channels` | Lists every channel that gets announcements, with its ping |
| `!reload [ping]` | Deletes every bot message in this channel (tracked posts plus the last 500 messages of history, including ones already deleted by hand) and reposts all games that are free right now. Pings only with `!reload ping` |

Channels set in `.env` can't be changed by command; edit `FLUXER_CHANNELS` instead. To use the bot in another community, invite it there with the same link first.

## Being nice to the APIs

- Requests to CheapShark identify the bot with a User-Agent like `fluxer-freegames-bot/1.0 (+https://github.com/NoBrainFox/fluxer-free-games; you@example.com)`, using `CONTACT_EMAIL`.
- CheapShark responses are cached in memory (stores for 24 hours, deals for 10 minutes), so commands don't cause extra API calls.
- The poll interval can't go below 15 minutes.
- Announcements are spaced 1.5 seconds apart to stay well under Fluxer's limit of 5 messages per 5 seconds per channel.

## Self-hosted Fluxer

By default the bot talks to the public instance at `api.fluxer.app`. For your own instance:

1. Create the bot application on **your** instance; tokens from fluxer.app don't work elsewhere and vice versa.
2. Set `FLUXER_API_URL` to your API base, the part of the URL before `/v1`. To find it, open your Fluxer web app, open the browser dev tools on the Network tab and look at any API request, e.g. `https://chat.example.com/api/v1/users/@me` means `FLUXER_API_URL=https://chat.example.com/api`.
3. Start the bot and check the log: it prints the API URL, the bot's name and the gateway URL it connects to. The gateway URL comes from your instance's `/gateway/bot` response; if it still points to `gateway.fluxer.app`, set `FLUXER_GATEWAY_URL` to your own gateway.
4. Invite the bot with your own domain in the URL, e.g. `https://chat.example.com/oauth2/authorize?client_id=…&scope=bot&permissions=84992`.

## Troubleshooting

**`Fluxer rejected the bot token`**: `FLUXER_BOT_TOKEN` is wrong. Copy the token from the **Bot** section of your application (User Settings > Applications), not the client secret. Resetting the token invalidates the old one, so update `.env` after every reset and run `docker compose up -d` again. Quotes and a `Bot ` prefix around the token are fine; the bot strips them.

## End dates

CheapShark doesn't say when a free offer ends, so for each new announcement the bot looks the game up in [Epic's free-games feed](https://store.epicgames.com/free-games) (exact dates for Epic Games Store) and on [GamerPower](https://www.gamerpower.com) (best effort for other stores, matched by title and store). Both lists are fetched at most every 30 minutes and only when there is something new to post. If no end date is found, the field is left out. Dates from GamerPower are credited with a link, as their API terms require.

With `DELETE_EXPIRED_POSTS=true`, a post with a known end date is deleted as soon as that date passes, without waiting for the grace period.

## Deleting expired posts

With `DELETE_EXPIRED_POSTS=true` the bot remembers the message ID of each announcement. After every successful poll, a game that has been missing from the free list for longer than `DELETE_GRACE_MINUTES` gets its post deleted and is forgotten, so a later giveaway of the same game is announced again. If CheapShark can't be reached, nothing is deleted. Removing a store from `STORES` counts as its games no longer being free. Bots can always delete their own messages, so no extra permission is needed.

## Data

The list of already announced deals (per channel) lives in `/data/posted.json` and the channels added with `!subscribe` in `/data/channels.json`, both in the `bot-data` Docker volume. Data from older single-channel versions is taken over automatically. Delete the volume (`docker compose down -v`) to start fresh. A deal that hasn't been free for 14 days is forgotten, so a later giveaway of the same game is announced again.

## Development

```sh
npm install
npm test
cp .env.example .env   # fill it in
node --env-file=.env src/index.js
```

## Credits

Deal data by [CheapShark](https://www.cheapshark.com). Store links go through CheapShark's redirect so they can keep their API free.

## License

[GPL-3.0](LICENSE)
