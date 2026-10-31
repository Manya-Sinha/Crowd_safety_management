# API Contract: Crowd Safety Management (v2)

This file is the agreement between **backend** (`app.py`, `database.py`) and **frontend** (`templates/`, `static/`).
It was written from the working `app.py` (646 lines) and is the reference for any merge.

**Rules**
1. The backend will NOT rename or remove any endpoint, form field or JSON field listed here.
2. The frontend may ONLY read the fields listed here.
3. If the UI needs new data, the backend ADDS a new field or endpoint (never changes an old one) and this file is updated in the same commit.
4. Frontend work only touches `templates/` and `static/`. Backend work only touches `app.py` and `database.py`.

Base URL on the event laptop: `http://192.168.4.2:5000`. For local testing: `http://localhost:5000`.

---

## Folder layout (required: `app.py` exits at startup if any file is missing)

```
app.py
database.py
requirements.txt
.gitignore
API.md
templates/index.html
templates/login.html
static/css/style.css
static/css/login.css
static/js/dashboard.js
static/js/login.js
static/captures/        (created automatically, NOT in git)
processed_images/       (created automatically, NOT in git)
```

---

## Authentication

Dashboard routes need a logged-in browser session (cookie). Device routes are public so the ESP32 can call them.

| Access | Endpoints |
|---|---|
| **Public** (ESP32, no login) | `POST /verify_frame`, `POST /periodic_frame`, `GET /entry`, `GET /exit`, `/login`, `/logout`, `/static/...` |
| **Login required** | `/`, `/status`, `/history`, `/hourly`, `/export.csv`, `/reset`, `/static/captures/<file>`, `/processed_images/<file>` |

Not logged in means HTTP 302 redirect to `/login`. This is why `curl` on a protected route returns the login page.
Frontend `fetch()` calls from a logged-in page send the cookie automatically (same origin). Do not change this.

### `GET /login`
Returns `templates/login.html`. If already logged in, redirects to `/`.
Template variables: `error` (string or `None`), `username` (string, to refill the box).

### `POST /login`  (form-encoded, not JSON)
| Form field | Notes |
|---|---|
| `username` | required |
| `password` | required |

- Success: sets session, redirects (302) to `/`.
- Wrong username: re-renders login with `error = "User not found. Check your username and try again."`
- Wrong password: re-renders login with `error = "Incorrect password. Please try again."`

### `POST /logout`
Clears the session, redirects to `/login`. Must be a POST (a link will not work; use a form or `fetch`).

---

## Dashboard endpoints

### `GET /`
Returns the dashboard page (`templates/index.html`).

### `GET /status`  (polled every couple of seconds)
```json
{
  "entry_count": 12,
  "exit_count": 5,
  "people_inside": 7,
  "max_capacity": 10,
  "zone_color": "orange",
  "critical": false,
  "people_in_frame": 3,
  "latest_image": "verify_20261031_101500_123456.jpg",
  "latest_heatmap": "heatmap_20261031_101500_123456.jpg",
  "alerts": [
    { "time": "10:15:00", "type": "orange", "message": "Entered ORANGE zone (7/10)" }
  ],
  "history": [
    { "time": "10:15:02", "value": 7 }
  ]
}
```
| Field | Meaning |
|---|---|
| `people_inside` | `max(entry_count - exit_count, 0)` |
| `zone_color` | `"green"`, `"orange"` or `"red"` |
| `critical` | `true` at 100% of capacity or more (show the flashing alert) |
| `people_in_frame` | people seen in the latest frame (verify or periodic) |
| `latest_image`, `latest_heatmap` | file names, may be `null`. Load from `/static/captures/<name>` |
| `alerts` | newest first, max 100. `type` is one of `info, green, orange, red, critical, entry, exit` |
| `history` | up to 150 points for the crowd graph, oldest first |

**Zone rules (backend logic, never duplicate them in the frontend):**
under 60% of `max_capacity` = green, 60% to under 90% = orange, 90% and above = red, 100% and above = red + `critical`.
`MAX_CAPACITY` is currently 10.

**Known behaviour (do not "fix" in the UI):** every call to `/status` adds one point to `history`.
Keep a single polling loop and do not poll faster than before, or the graph fills with duplicates.

### `GET /history?limit=50`
`limit` is 1 to 500, default 50.
```json
{
  "events": [
    {
      "id": 41,
      "timestamp": "2026-10-31 10:15:00",
      "direction": "ENTRY",
      "people_count": 3,
      "current_occupancy": 7,
      "image_filename": "verify_....jpg",
      "trigger_type": "Human"
    }
  ],
  "stats": {
    "total_entries": 12,
    "total_exits": 5,
    "peak_occupancy": 9,
    "total_events": 40
  }
}
```
`direction` is one of `ENTRY, EXIT, RESET, TRIGGER, OBJECT`. Newest first.
`people_count` can be more than 1 (a group counted together).
On failure: HTTP 500 with `{ "error": "..." }`.

### `GET /hourly?hours=24`
`hours` is 1 to 168, default 24.
```json
[ { "hour": "2026-10-31 10:00", "entries": 12, "exits": 7 } ]
```

### `GET /export.csv`
Downloads all events as `crowd_events.csv`.
Columns: `id, timestamp, direction, people_count, current_occupancy, image_filename, trigger_type`.

### `GET|POST /reset`
Resets entry and exit counters to 0. Returns `{ "status": "ok", "message": "Counters reset to 0" }`.
The dashboard should ask for confirmation before calling it.

### Images (login required)
- `GET /static/captures/<filename>`
- `GET /processed_images/<filename>`

Both serve the same saved frames (captures folder first, then processed_images). Only the newest 500 images per folder are kept.

---

## Device endpoints (ESP32-CAM only, the frontend must not call these)

### Counting flow (already built, multi-person)
1. Beam breaks, so the ESP32 sends a photo to `POST /verify_frame`.
2. The server counts people in the photo (`people_detected`) and remembers that number.
3. The ESP32 then calls `GET /entry` or `GET /exit`. The direction comes from which route is called.
4. The server adds the remembered number (a group of 3 counts as 3) and forgets it, so one photo is counted once.

### `POST /verify_frame`
Body: raw JPEG bytes.
```json
{
  "status": "ok",
  "is_human": true,
  "people_detected": 3,
  "trigger_type": "Human",
  "image_filename": "verify_....jpg",
  "entry_count": 12,
  "exit_count": 5,
  "people_inside": 7
}
```
`trigger_type` is `"Human"` or `"Object/False Trigger"`. Non-human triggers add an orange alert.
Bad image: HTTP 400 `{ "error": "could not decode image", "is_human": false }`.
Optional `?direction=entry|exit` counts here directly, but only if `AUTO_COUNT_FROM_VERIFY = True` in `app.py` (currently `False`, to avoid double counting). Leave it off.

### `POST /periodic_frame`
Body: raw JPEG bytes. Ambient frame for the live view and heatmap only (never counted).
Returns `{ "status": "ok", "people_detected": 3 }`. Bad image: HTTP 400.

### `GET /entry`
Counts the people from the last verified frame as entries.
```json
{ "status": "ok", "entry_count": 15, "people_crossed": 3, "people_inside": 10 }
```
If there is no verified person waiting:
```json
{ "status": "ignored", "message": "No verified people to count", "entry_count": 12, "people_inside": 7 }
```

### `GET /exit`
Same as `/entry`, for exits.
```json
{ "status": "ok", "exit_count": 8, "people_crossed": 3, "people_inside": 4 }
```
or `{ "status": "ignored", "message": "No verified people to count", "exit_count": 5, "people_inside": 7 }`.

---

## Testing without the ESP32

`/entry` and `/exit` only count after a verified photo, so send a photo with people first.

```bash
# 1. send a photo with people (copy of a group photo)
curl --data-binary @group.jpg http://localhost:5000/verify_frame
# 2. then register the crossing
curl http://localhost:5000/entry
curl --data-binary @group.jpg http://localhost:5000/verify_frame
curl http://localhost:5000/exit
```
Protected routes (`/status`, `/reset`, ...) need a session, so test them in the browser after logging in,
or with `curl -c jar.txt -d "username=...&password=..." http://localhost:5000/login` and then `curl -b jar.txt http://localhost:5000/status`.

---

## Known issues (for the backend owner, not for the frontend)

- Login credentials are hard-coded in `app.py` (`LOGIN_USERNAME`, `LOGIN_PASSWORD`). Move them to environment variables before the repo is public.
- `/exit` has no "nobody inside" check. If more exits than entries are counted, `exit_count` can exceed `entry_count`; `people_inside` stays at 0 but later entries are hidden until the difference is made up.
- `/verify_frame` and `/entry` or `/exit` are separate calls with no time limit between them. A stale photo count stays until used or replaced.
