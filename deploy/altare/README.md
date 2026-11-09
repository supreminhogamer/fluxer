# Fluxer — Altare GitHub Deploy (experimental)

This directory contains a native, **no-Docker / no-Snap-daemon / no-systemd** launcher based on the precompiled official Fluxer Server Snap revision 7 (2026.1104.180331).

**Not a guaranteed one-click production deploy.** Importing a GitHub repository cannot provision missing PostgreSQL, storage persistence, UDP/TURN networking or SMTP/OAuth credentials. The complete application has not been end-to-end validated on Altare.

## Deployment

1. Merge this PR to main and ensure the **Publish Altare native runtime bundle** GitHub Action produces the tag `altare-bundle-snap-r7`. The runtime downloads and verifies that release using SHA-256; it will refuse to run before the asset is published.
2. On Altare, import `supreminhogamer/fluxer`, and if possible set application root to `deploy/altare`. Build command: `npm run build`. Start command: `npm start`. If the root cannot be changed, build with `cd deploy/altare && npm run build`, start with `node deploy/altare/launcher.mjs`. Use Node.js 20+.
3. Use a **separately configured HTTPS reverse proxy or tunnel** for `https://chat.example.com`: Altare's generic web-app hosting docs do **not** provide custom domains and HTTPS automatically. Set `FLUXER_PUBLIC_ORIGIN=https://chat.example.com` (or `ALTARE_URL`) yourself. Set `PORT` to the Altare-allocated listening port. The proxy must forward WebSocket connections and the original Host header.
4. A **non-root** process can run bundled PostgreSQL. If your Altare sandbox is UID 0 (as in the previous sandbox), you **must** configure an external persistent PostgreSQL using `FLUXER_POSTGRES_URL` (or `DATABASE_URL`). PostgreSQL refuses to run as root. Do not put credentials in Git.
5. Set `FLUXER_ALTARE_DATA_DIR` to an actually persistent Altare volume. Default `~/fluxer-data` is NOT guaranteed to persist through redeploys. Keep backups of state, object data and secrets.
6. Retrieve the setup token from the private data directory's `secrets.env` in your server terminal, never in public logs.

## Full-feature limitations

- LiveKit needs externally accessible media TCP/UDP allocations (defaults 7881 TCP / 7882 UDP), the correct public `FLUXER_LIVEKIT_NODE_IP`, and often external TURN. Altare's HTTPS proxy alone cannot carry WebRTC UDP. Configure `FLUXER_LIVEKIT_TURN_SERVERS` if available.
- Upload/download uses local SeaweedFS and media-proxy relay, avoiding browser-facing presigned S3. Test media functionality and ensure persistent disk.
- Email/OAuth providers require their own keys. Free Altare resource limits may be insufficient for all services.
- This is NOT an alternative to Altare's permissions or resource limits. It does not use privileged kernel operations, ptrace or PRoot.

## Environment options

| Variable | Use |
| --- | --- |
| `ALTARE_URL` / `FLUXER_PUBLIC_ORIGIN` | Public HTTPS origin |
| `PORT` | HTTP port to listen on, forwarded by Altare |
| `FLUXER_POSTGRES_URL` / `DATABASE_URL` | External Postgres, required if root |
| `FLUXER_ALTARE_DATA_DIR` | Persistent data directory |
| `FLUXER_ALTARE_RUNTIME_DIR` | Extracted runtime cache |
| `FLUXER_LIVEKIT_NODE_IP` | Reachable LiveKit media IP |
| `FLUXER_LIVEKIT_TCP_PORT`, `FLUXER_LIVEKIT_UDP_PORT` | Media allocations |
| `FLUXER_LIVEKIT_TURN_SERVERS` | JSON TURN config |
| `FLUXER_ALTARE_BUNDLE_URL` / `FLUXER_ALTARE_BUNDLE_SHA256_URL` | Override trusted bundle URLs |

Altare's public docs also do not guarantee selecting a repository subdirectory as a build root, so configuring the build/start command may be necessary; pure import-only setup is not assured.

Run `cd deploy/altare && npm test && npm run build` to validate configuration and Snap-script patch logic. Passing these tests does **not** establish operational compatibility with Altare; perform a full deployment and voice, media and persistence smoke test before production.
