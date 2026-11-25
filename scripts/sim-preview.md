# Sim preview

The live Worker uses `wrangler.toml` (copied from `wrangler.example.toml`, worker name `neural-dance-engine`). This preview is a second Worker. It does not take those routes.

| | Live | Preview |
| --- | --- | --- |
| Start from | `wrangler.example.toml` | `wrangler.sim.example.toml` |
| Local config (gitignored) | `wrangler.toml` | `wrangler.sim.toml` |
| Name | `neural-dance-engine` | `neural-dance-engine-sim` |
| URL | your deployed host | `*.workers.dev` only |
| Params | static `params.json` | Durable Object `SIM_PARAMS` plus the file |

`workers_dev` is on. There is no `[[routes]]` block. The `SIM_PARAMS` binding and its migration exist only in the sim config. Do not copy them into `wrangler.toml`.

The preview page at `/neural-dance/sim/` is stamped with `<meta name="nd-sim-live" content="1">` only when that binding is present. A local static server serves the file without the stamp, so those tabs keep polling `params.json` and do not open a socket.

## First preview deploy

```bash
cp wrangler.example.toml wrangler.toml
cp wrangler.sim.example.toml wrangler.sim.toml
npm run smoke:sim
npm run build
npx wrangler@4.143.0 deploy --config wrangler.sim.toml
```

Wrangler prints the workers.dev host. The sim is:

`https://neural-dance-engine-sim.<subdomain>.workers.dev/neural-dance/sim/`

Do not run `npx wrangler deploy` without `--config wrangler.sim.toml` if you meant to publish only the preview Worker.

Set the write secret once on the preview Worker. Pick a long random value. It is not stored in the repo and it is not sent to the browser.

```bash
npx wrangler@4.143.0 secret put SIM_PARAMS_TOKEN --config wrangler.sim.toml
```

Writes and reset fail closed until that secret exists. Reads and the sim tab's WebSocket do not use it.

## Push a tweak without deploying

Leave the sim tab open. A partial update lands in under a second. Only keys from `static/neural-dance/sim/params.json` are accepted (`bpm`, the other numbers, the boolean flags, and `masses`). Unknown keys are rejected and nothing is stored.

```bash
curl -sS -X PATCH \
  -H "Authorization: Bearer $SIM_PARAMS_TOKEN" \
  -H "content-type: application/json" \
  -d '{"bpm":128}' \
  "https://neural-dance-engine-sim.<subdomain>.workers.dev/api/neural-dance/sim/params"
```

`POST` replaces the whole override set. `PATCH` merges. `GET` (no token) returns the current overrides:

```bash
curl -sS \
  "https://neural-dance-engine-sim.<subdomain>.workers.dev/api/neural-dance/sim/params"
```

Reset clears the overrides. The open tab goes back to `params.json` (and the built-in defaults for any key the file does not set):

```bash
curl -sS -X DELETE \
  -H "Authorization: Bearer $SIM_PARAMS_TOKEN" \
  "https://neural-dance-engine-sim.<subdomain>.workers.dev/api/neural-dance/sim/params"
```

`Authorization: Bearer` is the header curl should send. `x-sim-params-token` is accepted as well. A missing or unset token is 401. A wrong token is 403.

## Code deploy reloads the open tab

A new preview deploy changes `/neural-dance/version.json`. An open sim tab on the preview host polls that file and reloads itself. The Durable Object keeps the current overrides, so the reloaded tab picks them up again.

```bash
npm run smoke:sim
npm run build
npx wrangler@4.143.0 deploy --config wrangler.sim.toml
```

A params-only curl does not need `npm run build`. A code change does.

## Tuning file

Edit `static/neural-dance/sim/params.json` when the change should ship in the file. The sim polls that URL about once a second and applies keys that actually changed. Sliders and checkboxes follow. Built-in defaults stay if the file is missing or the request fails, so a file that matches those defaults does not move the dance.
