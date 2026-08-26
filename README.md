# ElevateBox Voice AI Prototype

This folder contains the first executable slice of the latency-first modular architecture. Its business workflow starts with fake external providers so lead qualification, callback interpretation, action timing, retries and idempotency can be tested without Exotel/OpenAI/WhatsApp spend. A direct OpenAI Realtime runtime is also implemented behind the provider-neutral voice boundary.

## What works

- Normalized, ordered per-call event history.
- Incremental, open-ended `LeadState` with evidence and confidence.
- Deterministic Hot/Warm/Cold classification over accumulated turns: price-plus-timeline buying intent is Hot, a concrete need with a readiness barrier is Warm, and just-looking without a concrete need is Cold.
- Explainable intent scoring with factor deltas, including a one-point reduction when the lead explicitly has no existing business and deterministic negative signals for opt-outs, repeated-call complaints, and hostility.
- Location and business-vs-individual evidence in the accumulated lead state.
- Callback resolution for supported India-time phrases such as “tomorrow morning” and “tomorrow at 4:30 pm”.
- Non-blocking supervisor and action queues.
- Intent-specific, idempotent actions: Hot details during the active call, Warm callback acquisition/booking, and a single Cold brochure delivery. Explicit negative or do-not-contact signals suppress follow-up messages.
- Truthful action directives: success is announced only after the adapter succeeds, with immediate one-sentence action results queued behind active audio.
- Contextual Hot/Warm follow-up with resume and architecture attachment references, plus a dedicated Cold brochure attachment.
- Duplicate-turn suppression and failure-injection tests.
- Direct OpenAI Realtime server WebSocket with pre-call readiness, semantic VAD, PCM streaming and normalized events.
- Barge-in support that exposes `user.speech_started` and truncates the assistant at the audio duration actually played.
- Exotel AgentStream bridge using 24 kHz linear16 end-to-end, with no live resampling or transcoding.
- Exotel output aggregation at its minimum valid 3,200-byte frame, playback marks, and immediate `clear` on barge-in.
- A single-use prepared-call coordinator that reaches Realtime READY before allowing the Exotel dial and expires abandoned sessions.
- Asynchronous caller transcription normalized into stable turns, including committed-turn reordering and failed/empty-turn skipping.
- A complete `LiveCallController` that moves stable turns to the supervisor, returns directives to Realtime, and ends the workflow on Exotel stop.
- Per-call measurements for prewarm, VAD turn gap, first model audio, telephony handoff and barge-in clear latency.
- Append-only local JSONL traces containing voice events, transcripts, lead-state changes, classifications, directives, action lifecycles and the final call summary.
- An authenticated preparation endpoint and bounded public WebSocket gateway for single-use Exotel media tokens.

Business descriptions, locations, products, requirements, blockers and buying signals are not selected from a catalogue. `LeadUnderstandingPort` accepts a stable lead turn, the preceding assistant utterance, and accumulated state. The preceding utterance resolves short answers such as “yes” or “around fifty” but is never treated as lead evidence. The model adapter validates an open-ended structured patch, while the local demo injects scripted patches so tests remain free and reproducible.

The voice and understanding models are deliberately separate configuration points. `OpenAIRealtimeRuntime` owns the live speech session; `OpenAIResponsesLeadPatchClient` implements structured sidecar extraction and requires its own `model` value. Changing that extraction model does not alter the call/media bridge, supervisor, lead state or action policies. The Responses request uses strict JSON Schema and `store: false`; invalid output is rejected before state mutation.

Input transcription is also independently configurable through `inputTranscriptionModel` and defaults to `gpt-live-transcribe`. It runs asynchronously as a source of stable supervisor turns; the speech-to-speech model continues consuming the original audio and does not wait for lead extraction or actions.

## Run

Install dependencies and run the free local suite:

```bash
npm install
npm test
npm run demo
```

To verify only the authenticated Realtime handshake, set `OPENAI_API_KEY` and run:

```bash
npm run smoke:realtime
```

The smoke command reaches `session.updated` and closes without sending audio. It is intentionally separate from the free test suite because OpenAI Realtime API usage is paid. Never commit the key; `.env.example` contains names only and the script reads the process environment.

For an interactive microphone test, set the key and run:

```bash
OPENAI_API_KEY=... npm run realtime:mic
```

This simulates an outbound ElevateBox call: Ayanabh speaks first, introduces ElevateBox as an e-commerce-focused development team, begins in Hindi, and asks whether it is a good time to talk. After the lead agrees, the assistant separately asks whether they prefer Hindi, Telugu, or English. An explicit choice locks the base language; ordinary code-switching does not change it. It captures the default local microphone through ffmpeg, streams mono 24 kHz PCM16 to OpenAI Realtime, prints lead and assistant transcripts, and plays response audio locally through one session-scoped ffplay process. Output is paced by Realtime response ID against a monotonic playback clock with an 80 ms jitter cushion rather than trusting exact Node timer intervals or dumping many seconds into ffplay. Tune the cushion with `REALTIME_PLAYBACK_BUFFER_MS` (20–250 ms). On barge-in it discards the current response's paced queue without closing the audio device, then truncates the Realtime conversation at the estimated audio position actually heard. If ffplay exits unexpectedly, the harness records it and restarts the sink. The harness omits `max_output_tokens` by default, restoring OpenAI's unlimited provider default; use `OPENAI_REALTIME_MAX_OUTPUT_TOKENS` only when deliberately testing a hard cap. Use headphones: this CLI path has no acoustic echo cancellation, so loud speaker output can otherwise trigger false interruptions.

The runner reports estimated endpoint/VAD delay, end-of-speech-to-first-audio (TTFA), and post-VAD first-audio latency separately. Stable lead turns are analyzed asynchronously through the independently configured `OPENAI_LEAD_MODEL`, so extraction does not block native speech. The microphone profile defaults the sidecar to `gpt-5.4-nano`, a compact latest-turn patch (no accumulated lead-state payload), a 500-token cap, and up to four extraction requests concurrently while applying state changes in transcript order. This adds one paid Responses request per stable lead turn. `REALTIME_SHOW_PARTIALS=1` displays diagnostic transcription deltas; partials do not gate the speech-to-speech response.

Each run prints a `logs/mic-*.jsonl` path and displays compact insight, classification, analysis, callback, and action events in the terminal. Set `REALTIME_SHOW_DOMAIN_EVENTS=0` for a quiet terminal without disabling the file. The append-only writer buffers file I/O and never records per-frame audio deltas. The trace includes final transcripts, per-turn sidecar duration/failure, locations, products, requirements, budget, timeline, callback interpretation, intent score and breakdown, Hot/Warm/Cold changes, directives, action lifecycle events, latency measurements, and a final summary. Logs can contain personal data and are excluded from git; handle or delete them according to your data-retention policy. WhatsApp delivery and callback booking use fake adapters in this command and are clearly logged as simulations. No Exotel request or telephone call is made. The assistant is now prompted to give a verbal goodbye when discovery is complete, but this microphone harness is not a telephone connection and still exits with Ctrl-C; a real Exotel hangup tool remains part of the later dial integration.

Set `REALTIME_MIC_DEVICE`/`REALTIME_MIC_FORMAT` for a different capture device, `REALTIME_NO_SPEAKER=1` to disable playback, or `REALTIME_LOG_DIR` to change the trace directory. The microphone profile defaults semantic VAD eagerness to `high`; set `OPENAI_SEMANTIC_VAD_EAGERNESS=auto` to compare the provider default. `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`, `OPENAI_REALTIME_REASONING_EFFORT`, `OPENAI_REALTIME_MAX_OUTPUT_TOKENS`, `OPENAI_REALTIME_HANDSHAKE_TIMEOUT_MS`, `OPENAI_LEAD_MODEL`, `OPENAI_LEAD_TIMEOUT_MS`, `OPENAI_LEAD_MAX_OUTPUT_TOKENS`, and `OPENAI_LEAD_CONCURRENCY` can be used to compare profiles. Each `lead.analysis.provider_request` trace records safe queue time, request time, and token usage so model latency can be separated from local concurrency. Configure `ELEVATEBOX_CONTACT_NUMBER`, `ELEVATEBOX_RESUME_PATH`, `ELEVATEBOX_BUILD_IMAGE_PATH`, and `ELEVATEBOX_BROCHURE_PATH` before testing follow-up content.

The demo prints the final lead state, directives, messages, callback booking and ordered event types. Replace the placeholder candidate number and attachment paths in `src/demo.ts` before any real follow-up.

## Module map

```text
src/contracts.ts                         Provider-neutral contracts
src/infrastructure/model-lead-understanding.ts
                                         Validated open-ended model boundary
src/infrastructure/openai-realtime-runtime.ts
                                         Provider-neutral Realtime protocol adapter
src/infrastructure/node-realtime-socket.ts
                                         Authenticated Node WebSocket transport
src/infrastructure/openai-responses-lead-client.ts
                                         Swappable structured extraction model client
src/infrastructure/exotel-call-adapter.ts
                                         Exotel protocol and zero-transcode media bridge
src/infrastructure/live-gateway-server.ts
                                         HTTP control plane and Exotel WebSocket boundary
src/infrastructure/scripted-understanding.ts
                                         Free deterministic test fixtures only
src/domain/classifier.ts                 Evidence-based intent classifier
src/domain/callback-time.ts              Asia/Kolkata callback resolver
src/domain/replay.ts                     LeadState reconstruction from events
src/domain/policy.ts                     Action and directive policy
src/application/supervisor.ts            Authoritative live lead state
src/application/conversation-orchestrator.ts
                                         Non-blocking directive queue
src/application/action-manager.ts        Idempotency, retry and provider dispatch
src/application/prototype-system.ts      Per-call control/action lane wiring
src/application/prepared-call-coordinator.ts
                                         Prewarm-before-dial session handoff
src/application/live-call-controller.ts  Full voice/telephony/workflow lifecycle
src/application/live-call-latency.ts     Per-call latency measurements and summaries
src/infrastructure/fake-adapters.ts      Free local provider substitutes
src/infrastructure/event-store.ts        Replayable in-memory event log
src/infrastructure/jsonl-call-trace.ts    Append-only local call-analysis trace
src/prompts/elevatebox-outbound.ts        Outbound multilingual sales behavior
```

## Next implementation slice

1. Add the production composition root and deploy the gateway behind a TLS endpoint; the app itself does not terminate TLS.
2. Add the Exotel dial request only after `/calls/prepare` returns a token and stream URL.
3. Run one measured trial call and capture the latency summary before tuning VAD/model settings.
4. Add Meta WhatsApp Cloud API and replace the in-memory event store/outbox after the voice path is stable.

`GET /health` is public. `POST /calls/prepare` requires `Authorization: Bearer <CONTROL_API_TOKEN>`, accepts a bounded JSON `SessionContext`, and prewarms the voice session before returning the single-use media URL. The `/media/:token` WebSocket can additionally require the configured Basic credentials. Unclaimed prewarms are aborted at token expiry or gateway shutdown. `PUBLIC_MEDIA_BASE_URL` must be an explicit public `wss://` URL; it is never inferred from an untrusted Host header. In production, terminate TLS at the deployment platform or reverse proxy and forward HTTP/WebSocket traffic to this process.

LiveKit is not required in the initial path. It remains an optional `ConversationRuntime` implementation for a measured end-to-end bake-off.
