# eHub Dispatch

The driver/courier console for the eHub ecosystem. It talks only to the
**gateway** (`EXPO_PUBLIC_GATEWAY_URL`), which fronts `dispatch-service` over
gRPC. It does not call the monolith.

## What it does

- Go online/offline and publish the driver's position; both ride and delivery
  feeds require a fresh position.
- Receive, accept and decline ride and delivery offers. Offers arrive on the
  gateway's SSE stream (`/dispatch/driver/stream`) and trigger an immediate
  refresh of the authoritative feed; the five-second poll remains as recovery.
- Drive a ride: accept → start → complete.
- Drive a delivery: accept → photograph the goods at pickup → wait for the
  merchant to release the order → photograph the dropoff and complete.
- Follow the active task on an OpenStreetMap route card: a dashed driver →
  pickup approach and a solid pickup → dropoff trip line, both decoded from the
  gateway's OSRM polyline.
- Review finished rides and deliveries.

Pickup and dropoff photos are uploaded to Firebase Storage under
`dispatch-proofs/<user-id>/<job-id>/`; the app sends only the resulting URL to
dispatch. Set `EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET` and make sure the storage
rules allow an authenticated driver to write that prefix.

## Setup

From the repository root (the monorepo is a Bun workspace with a root
`bun.lock`):

```bash
bun install
```

Create `apps/dispatch/.env.local` from `.env.example` and fill in:

- `EXPO_PUBLIC_GATEWAY_URL` — e.g. `http://10.0.2.2:9010/api/v1/gateway` for the
  Android emulator, or a LAN IP for a physical device.
- `EXPO_PUBLIC_FIREBASE_*` — Firebase web config for driver sign-in and proof
  uploads.
- `EXPO_PUBLIC_OSM_TILE_URL` — OpenStreetMap raster tile template for the route
  map. It defaults to the public OSM endpoint, which is development-only; use
  MapTiler, Stadia, Thunderforest or a self-hosted tile server for production.

Start the app:

```bash
cd apps/dispatch
bunx expo start
```

The offer stream uses `expo/fetch` streaming and sends the session token in the
`Authorization` header. The gateway also accepts `?token=` for browser
EventSource clients that cannot set headers, but the native app avoids that
carrier so the token never enters the URL or the gateway access log.

The route card uses `react-native-maps`. Expo Go includes the native module, but
a standalone or development build needs the `react-native-maps` config plugin
with a Google Maps API key on Android (`androidGoogleMapsApiKey`) even though
the visible basemap is OpenStreetMap. A fully Google-free renderer would require
swapping the map component to MapLibre.

## Checks

```bash
bunx tsc --noEmit
bunx expo lint
```

`bunx tsc --noEmit` passes. `bunx expo lint` currently hits a workspace-level
import-resolver error in this checkout (`node_modules/es-abstract` is missing a
file), so the lint output is not a reliable signal until the root dependencies
are reinstalled cleanly.
