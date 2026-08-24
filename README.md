# Pi Desk Dashboard

A touchscreen desk dashboard for a Raspberry Pi Zero 2W (1024×600). A Python/FastAPI
backend proxies and caches all data; a no-build vanilla-JS frontend runs fullscreen in a
Chromium kiosk.

**Home** big clock + date · weather (with dew point, wind, sunrise/sunset, moon phase) ·
auto-rotating world-clock carousel · stocks/indices strip · big app-launcher tiles.

**Apps** (open from the launcher, return with the Back button):
- ✈️ **Aircraft** — dark map of nearby planes + a "where to look" panel for the closest
  airborne aircraft (compass azimuth, elevation above the horizon, distance in miles),
  flight number, departure→destination route, and a photo of the plane.
- 🌧️ **Rain Radar** — dark map with the current RainViewer frame and a rain
  **start/stop prediction** for your exact location.
- 🚆 **Trains** — National Rail (Darwin) live departure board.

## Architecture

```
Chromium kiosk (localhost:8080) ──HTTP──> FastAPI backend ──> Open-Meteo (weather)
   home / aircraft / radar / trains            cache +        RainViewer (radar)
                                               config store    airplanes.live (aircraft)
                                                               adsbdb / planespotters (route, photo)
                                                               Yahoo Finance (stocks)
                                                               Darwin SOAP (trains)
```

The backend is the only thing that talks to the internet and holds the secrets. Every
upstream is cached (per-source TTL) so rate limits are respected and the UI stays responsive
even if a source is slow — stale data is served with a `stale` flag the UI shows as a badge.

## Data sources & keys

| Module  | Source | Key needed? |
|---------|--------|-------------|
| Weather | Open-Meteo | no |
| Radar   | RainViewer (free radar tiles cap at zoom 7) | no |
| Aircraft| airplanes.live (1 req/sec) | no |
| Route   | adsbdb.com | no |
| Photo   | planespotters.net | no |
| Stocks  | Yahoo Finance chart endpoint | no |
| Trains  | National Rail **Darwin OpenLDBWS** (SOAP) | **yes** (legacy token) |

> ⚠️ The Darwin SOAP token is the **legacy** OpenLDBWS credential, being retired through
> 2026 in favour of the Rail Data Marketplace REST API. The rail provider sits behind a
> `RailProvider` interface (`backend/app/providers/trains.py`) so a REST implementation can
> be dropped in later. Keep the token in `config.yaml` only — never commit it.

## Configuration

Runtime config lives in `config.yaml` (gitignored). Copy the template and edit:

```bash
cp deploy/config.example.yaml config.yaml      # local dev
# on the Pi the real file lives at /data/config.yaml
```

Key fields: `location` (lat/lon/timezone — no GPS, so this is how the Pi knows where it
is), `trains.token` / `station_crs` / `destination_crs`, `world_clocks`, `stocks.symbols`,
`admin_token` (gates the location/settings POST endpoints), and cache/refresh intervals.
The phone remote asks for this token before it can change settings, drive the screen, or
reboot the Pi; it stores it only for the lifetime of that browser tab.

Push a new location at runtime without editing the file:

```bash
curl -X POST http://<pi>:8080/api/location \
  -H "X-Admin-Token: <admin_token>" -H 'Content-Type: application/json' \
  -d '{"lat":52.4823,"lon":-1.8990,"label":"Birmingham"}'
```

## Local development

```bash
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt   # Windows
# .venv/bin/pip install -r requirements-dev.txt               # Linux/macOS
.venv/Scripts/python -m uvicorn app.main:app --port 8080
```

Open http://localhost:8080. Run the tests (they are fully offline — every upstream is
mocked with `httpx.MockTransport`):

```bash
cd backend && .venv/Scripts/python -m pytest -q
cd ../frontend && npm test
```

## Deploy to the Pi

Target: Raspberry Pi OS Lite (Bookworm, 64-bit), default `pi` user.

### 1. Passwordless SSH (from your dev machine)
```bash
ssh-keygen -t ed25519 -f ~/.ssh/pi_dashboard          # if you don't have a key
ssh-copy-id -i ~/.ssh/pi_dashboard.pub pi@<pi-host>   # copies your public key
ssh -i ~/.ssh/pi_dashboard pi@<pi-host>               # now logs in without a password
```

### 2. Provision
On the Pi (set `DASHBOARD_REPO_URL` to your repo's SSH URL):
```bash
sudo mkdir -p /data && sudo chown pi:pi /data
DASHBOARD_REPO_URL=git@github.com:<you>/dashboard.git \
  bash /data/dashboard/deploy/scripts/setup-pi.sh
```
`setup-pi.sh` (idempotent) installs packages, creates the venv, generates a **read-only
GitHub deploy key** before cloning (it pauses so you can add the printed key under repo
Settings → Deploy keys), seeds
`/data/config.yaml`, and installs/enables the systemd services. Then edit
`/data/config.yaml` (token, station, location, `admin_token`).

If the repository is not present yet, run the setup script from a temporary bootstrap
copy; a script inside an un-cloned private repository cannot invoke itself.

### 3. Auto-update (git poll)
`dashboard-update.timer` runs `deploy/scripts/update.sh` every ~2 minutes: it `git fetch`es,
and if `origin/main` moved, hard-resets to it, reinstalls deps only if
`requirements.txt` changed, and restarts the services. Just push to `main` to deploy.

Changes under `deploy/systemd/` or `deploy/sudoers/` require re-running `setup-pi.sh` with
sudo; the unprivileged updater deliberately cannot install root policy.

### 4. Power-off resilience (do this LAST)
First verify that `/data` is a separate writable mount (`findmnt /data` must show `/data`,
not `/`). Only then enable the read-only overlay root filesystem so yanking the power can't
corrupt the SD card:
```bash
sudo raspi-config   # Performance -> Overlay File System -> enable
```
The OS root becomes RAM-backed/read-only; a separately mounted **`/data` stays writable**
for the app, config and git updates. A plain `/data` directory on `/` does not—its changes
would disappear on reboot. The Chromium profile is kept in `/dev/shm` (tmpfs).

For the optional hardware watchdog, Wi-Fi recovery, persistent journal, and scheduled
reboot units, run `sudo bash deploy/scripts/harden-pi.sh` after provisioning.

## Layout

```
backend/app/
  main.py            FastAPI app; serves /api/* and the static frontend
  config.py          config.yaml loader (+ runtime POST updates), strips secrets
  cache.py           async TTL cache w/ single-flight + last-good-on-error
  providers/         weather, radar, radar_forecast, aircraft, route, photos,
                     stocks, trains (Darwin SOAP), geo + moon helpers
  routers/           api.py (data), config_api.py (config/location)
backend/tests/        offline pytest suite (httpx MockTransport)
frontend/            index.html, css/, js/app.js + js/modules/*, vendored Leaflet
deploy/              config.example.yaml, systemd units, sudoers, setup/update scripts
```
