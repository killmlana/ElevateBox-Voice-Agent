# One-VPS deployment notes

The primary telephone carrier is Zadarma. Asterisk originates one TLS/SRTP SIP leg to OpenAI and, only after that leg reaches `AI_READY`, originates the PSTN leg through the `zadarma` PJSIP endpoint. ElevateBox controls the lifecycle through loopback-only ARI; it never proxies audio.

```text
Zadarma PSTN <-> Asterisk <-> OpenAI Realtime SIP
                    |
                   ARI
                    |
              ElevateBox -> OpenWA
```

These files are templates, not an installer. They contain no credentials and do not make calls.

## Service layout

- Install Asterisk as the operating system's native systemd service.
- Run ElevateBox as its own systemd service, bound to `127.0.0.1:8080`.
- Keep ARI at `http://127.0.0.1:8088/ari` using `http.conf.example` and `ari.conf.example`.
- Keep the existing OpenWA Docker Compose ports on loopback.
- Run cloudflared as a native systemd service. Its hostname exposes only the HTTP control plane and `POST /webhooks/openai/realtime`.
- Send SIP and RTP directly over the VPS public network; Cloudflare Tunnel is not in the media path.

Copy the relevant Asterisk snippets into `/etc/asterisk`, replace all angle-bracket placeholders, set matching `ASTERISK_ARI_*` credentials in `/etc/elevatebox/elevatebox.env`, and reload/restart Asterisk through the normal service workflow. Do not commit either provider credentials or the deployed environment file.

## Zadarma Authorization by IP

The deployed Zadarma route uses an IP-authorized SIP trunk. Add the VPS public
IP under **Authorization by IP**, enable it, then call Zadarma's free `8888`
service once from Asterisk to confirm the address. The selected SIP login is
unavailable for password registration while attached to this trunk, so the
sample intentionally defines no PJSIP registration or outbound-auth object.
`pjsip show registrations` should therefore report `No objects found`.

The trunk's selected CallerID is Zadarma's default. ElevateBox leaves
`ZADARMA_CALLER_ID` blank and Asterisk uses `send_pai=no` so it does not override
that selection. Zadarma's free `4444` echo service can verify the confirmed
trunk without placing a PSTN call.

The free SIP number/login is an internal account identifier, not a public PSTN
number that recipients can see or call back. Outbound calls still require an
eligible verified CallerID and available account credit or plan minutes.

The OpenAI project webhook should target:

```text
https://voice.example.com/webhooks/openai/realtime
```

Subscribe it to `realtime.call.incoming` and place the generated signing secret in `OPENAI_WEBHOOK_SECRET`. The receiver validates the signature against the exact raw request body, rejects stale signatures, and deduplicates `webhook-id` in process.

## Network policy

- Permit outbound TCP/TLS 5061 to `sip.api.openai.com`.
- Permit bidirectional SRTP UDP to OpenAI's currently documented media CIDRs. At the time this template was written those are `13.79.45.80/28`, `23.98.140.64/28`, `40.67.149.176/28`, and `40.83.204.240/28`; re-check the OpenAI SIP networking page before applying a firewall rule.
- Permit the configured Zadarma SIP signaling and RTP traffic using Zadarma's current published requirements.
- Expose only Asterisk's required SIP/RTP ports. Never expose ports 8080 (ElevateBox), 8088 (ARI), or the OpenWA port directly to the Internet.
- The sample RTP range is UDP 10000–20000; keep `rtp.conf` and the firewall identical.

## Safe rollout

Keep these values until the deployment is healthy:

```dotenv
OUTBOUND_CALL_PROVIDER=asterisk-sip
SIP_DIAL_MODE=dry-run
ALLOW_PAID_SIP_CALLS=
WHATSAPP_MODE=dry-run
CALLBACK_MODE=dry-run
```

Dry-run performs no OpenAI, Asterisk, Zadarma, WhatsApp, or callback mutation. Automated tests and service checks must remain in this mode. Enabling the live SIP route additionally requires `ELEVATEBOX_MODE=live`, all OpenAI/ARI credentials, a confirmed Zadarma IP trunk, and the exact paid-call acknowledgement documented in `.env.example`. The first real call should be one explicitly approved recipient and destination.

On application startup the ARI adapter enumerates and terminates channels and bridges whose deterministic IDs begin with `elevatebox-`. This prevents prior-process orphans from surviving a normal restart. Durable cross-restart recovery and idempotency are still required before concurrent production traffic.

After a staging bridge forms, inspect both channels' Asterisk read/write formats. ElevateBox logs `asterisk.formats.negotiated` and a `codecMatch` boolean. Call the route “no transcoding” only when the AI read/write formats match the inverse Zadarma formats; `allow=alaw,ulaw` merely expresses preference and is not proof.

References: [OpenAI Realtime SIP](https://developers.openai.com/api/docs/guides/realtime-sip), [OpenAI webhook verification](https://developers.openai.com/api/docs/guides/webhooks), [Asterisk ARI channels](https://docs.asterisk.org/Latest_API/API_Documentation/Asterisk_REST_Interface/Channels_REST_API/), [Asterisk ARI bridges](https://docs.asterisk.org/Latest_API/API_Documentation/Asterisk_REST_Interface/Bridges_REST_API/), and [Zadarma Asterisk PJSIP trunk](https://zadarma.com/en/support/instructions/asteriskpjsip/trunk/).
