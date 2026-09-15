# Deploying the connector and connecting it to Claude

Written to be followed at a keyboard, in order. Each step says what to check before moving on,
because most of the ways this goes wrong are silent — a wrong redirect URI or a proxy hiding
the caller's IP both look like "it just doesn't work".

---

## Step 0 — prove it locally first (recommended)

Do this before touching a server. It exercises the same OAuth flow and the same tools, and it
costs half an hour instead of half a day of firewall guessing.

```bash
# terminal 1 — the portal
php artisan serve --port=8000
```

In the portal: **Administration → Portal Connector → Settings & Activity**

1. **Service token** → How: *Generate one for me* → reason → **Generate token**. Copy the value.
2. **Redirect URIs** → add `http://localhost:8787/callback` → reason → Save.

```bash
# terminal 2 — the connector
cd connector
npm ci
npm run build

cat > .env <<'EOF'
CONNECTOR_ISSUER=http://localhost:8787
PORT=8787
PORTAL_BASE_URL=http://127.0.0.1:8000
PORTAL_SERVICE_TOKEN=<the token you just copied>
EOF

npm start
```

It prints the callback URL it expects. It must match what you registered, character for
character.

Then connect Claude Code to it:

```bash
claude mcp add --transport http ecommarise http://localhost:8787/mcp
```

Claude opens a browser at the portal's consent screen, you approve, and the tools appear. Ask
it something like *"what is the on-time delivery target?"* and it should call
`get_rule_or_variable`.

**If that works, everything below is deployment, not debugging.**

---

## Step 1 — the portal on your server

```bash
git checkout dev && git pull
php artisan migrate --force
php artisan config:clear && php artisan route:clear && php artisan view:clear
```

Check `php artisan migrate:status | tail` — the six `2027_02_2*` connector migrations should
all say Yes.

**Who gets access** — Administration → Settings → Roles. The migration already granted the
Team Lead everything except Finance figures, and the other roles their own modules. Change it
there if you want something different; nothing about connector access is set anywhere else.

**The portal does NOT need to be reachable from the internet.** Anthropic's cloud never talks
to it. It needs to be reachable by:

- your **team's browsers**, for the consent screen — it already is, that is how people use it;
- the **connector service**, for the internal API — see Step 3.

---

## Step 2 — the connector on a public HTTPS host

Node 20 or newer.

```bash
git clone <repo> ecommarise && cd ecommarise/connector
npm ci
npm run build
```

`.env`:

```
CONNECTOR_ISSUER=https://connector.yourdomain.com
PORT=8787
PORTAL_BASE_URL=http://10.0.0.5          # the portal, privately
PORTAL_SERVICE_TOKEN=<generated in the portal>
ACCESS_TOKEN_TTL=3600
REFRESH_TOKEN_TTL=2592000
DATA_DIR=data
```

`CONNECTOR_ISSUER` must be `https://` — the service refuses to start otherwise, because an
issuer on plain HTTP hands every token to anyone on the path.

**TLS in front of it.** The service speaks plain HTTP on its port; terminate TLS in nginx or
Caddy and proxy through. Caddy, for example:

```
connector.yourdomain.com {
    reverse_proxy 127.0.0.1:8787
}
```

**Keep it running** — systemd:

```ini
[Unit]
Description=Ecommarise Connector
After=network.target

[Service]
WorkingDirectory=/srv/ecommarise/connector
ExecStart=/usr/bin/node dist/index.js
EnvironmentFile=/srv/ecommarise/connector/.env
Restart=always
User=ecommarise

[Install]
WantedBy=multi-user.target
```

**Check before moving on**, from your own machine, not the server:

```bash
curl https://connector.yourdomain.com/healthz
curl https://connector.yourdomain.com/.well-known/oauth-authorization-server
```

The second must return JSON naming your issuer. If it does not, Claude will not be able to
discover how to authenticate and the error you get later will not say so.

---

## Step 3 — wire the two together

Back in the portal, **Administration → Portal Connector → Settings & Activity**:

1. **Redirect URIs** → `https://connector.yourdomain.com/callback`
   Exactly that. No trailing slash, no wildcard — it is matched character for character, and a
   mismatch shows up as a refusal page with no detail, on purpose.

2. **IP allow-list** → leave it **empty for now**. The token is already protecting the API.
   Fill it in at Step 5, from evidence rather than guesswork.

3. Make sure the connector host can actually reach the portal:

```bash
# on the connector host
curl -i http://10.0.0.5/internal/connector/exchange
```

A `401` is the right answer — it means you reached the portal and it refused you for having no
token. A timeout means a firewall, and a `503` means the portal has no service token set.

---

## Step 4 — add it in Claude

On claude.ai: **Settings → Connectors → Add custom connector**

- URL: `https://connector.yourdomain.com/mcp`

Nothing else to fill in — the connector registers itself. Each person does this once, on their
own account.

Claude sends you to the portal's consent screen, signed in as yourself. Approve, and the ten
tools appear.

**Each person signs in as themselves.** The service token is the connector's, not theirs — it
proves the call came from your connector, and the portal decides what to serve from the
signed-in user's own role.

---

## Step 5 — verify, including the refusals

Ask Claude, in this order:

| Ask | Expect |
|---|---|
| "What is the on-time delivery target in Sourcing?" | A number with its label, cited |
| "What does the knowledge base say about raising a purchase order?" | Empty, politely — nothing is published yet, and it should offer to file a GUIDE-FAQ pointer rather than invent an answer |
| Something in a module your role is not in | A refusal naming who owns it |

Then in the portal:

- **Settings & Activity → Recent calls** — every call, served and refused
- **Administration → Activity Logs** — the same calls against your name

**Now fill in the IP allow-list.** The "Addresses the portal has seen the connector call from"
line on the settings screen shows the real address. Put that in the allow-list and save.

Confirm it did not lock the connector out: ask Claude one more question. If it now refuses, the
address in the box is not what the portal is actually seeing — see the proxy note below.

---

## The three things that actually go wrong

**1. A reverse proxy in front of the portal hides the connector's IP.**
If the portal sits behind nginx or Cloudflare, every request looks like it comes from the
proxy. The allow-list then either blocks everything or allows everything, and nothing says so.
Either configure `App\Http\Middleware\TrustProxies` properly, or leave the allow-list empty and
rely on the token. Empty is honest; a list that matches the proxy is worse than none, because
it looks like a control and is not one.

**2. The redirect URI is nearly right.**
`https://connector.yourdomain.com/callback/` with a trailing slash is a different string, and
the consent screen refuses it without explaining — deliberately, since explaining would help
somebody probing for a redirect they can widen. The connector prints the exact URL it will use
at startup. Copy it from there.

**3. Rotating the token and forgetting the connector.**
Rotation keeps the previous token working for the grace window you choose (default an hour).
Update `PORTAL_SERVICE_TOKEN` on the connector host and restart within that window, then use
**Revoke it now** on the settings screen. Miss the window and the connector stops until you
update it — no data is lost, but nobody's Claude works until you do.

---

## What you will not be able to test yet

- **`read_db_views`** refuses every call. No curated views exist and no read-only database user
  is provisioned — see §3.3 of [the feasibility review](../docs/ECOMMARISE_CONNECTOR_FEASIBILITY.md).
  This is intended, not broken.
- **`ask_knowledge`** returns nothing until knowledge chunks are written and activated. The
  §08 population run is what fills it, and it needs the connector working first — which is what
  you have just done.
- **The AI task queue** needs a task instruction before anything can be assigned to Claude:
  Administration → Portal Connector → Task Instructions → create one → make it live.
