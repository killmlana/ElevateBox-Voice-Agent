# ElevateBox Voice AI — Architecture

The system is built around one hard constraint: **lead audio must never enter the Node
process.** Everything else — supervision, classification, policy, WhatsApp delivery,
callback booking — is arranged *around* that audio path rather than inside it.

That produces three planes that run concurrently and are only allowed to touch each
other through narrow, explicit seams:

| Plane | Owns | Latency budget |
| --- | --- | --- |
| **Media** | Lead ↔ Zadarma ↔ Asterisk ↔ OpenAI Realtime SIP | carrier RTP, no Node hop |
| **Control** | Call lifecycle, signed webhooks, the media-free sideband socket | milliseconds, off the audio path |
| **Supervision & actions** | LeadState, Hot/Warm/Cold, directives, WhatsApp, callbacks | free to be slow — nothing waits on it |

---

## 1. Nodes

Identified before graphing, grouped by plane.

### Media plane — carries audio, contains no ElevateBox code

| Node | What it is |
| --- | --- |
| Lead handset | PSTN subscriber |
| Zadarma | Primary PSTN carrier, PJSIP trunk, Authorization by IP |
| Asterisk | `mixing,proxy_media` bridge, `alaw,ulaw` preferences on both legs |
| OpenAI Realtime SIP | Speech-to-speech model terminating its own SIP/SRTP leg |

### Control plane — `src/infrastructure`, `src/application`

| Node | File |
| --- | --- |
| `LiveGatewayServer` | `infrastructure/live-gateway-server.ts` |
| `VerifiedOpenAIWebhookReceiver` | `infrastructure/openai-webhook-receiver.ts` |
| `AsteriskSipCallCoordinator` | `application/asterisk-sip-call-coordinator.ts` |
| `AsteriskAriAdapter` | `infrastructure/asterisk-ari-adapter.ts` |
| `OpenAISipSidebandAdapter` | `infrastructure/openai-sip-sideband-adapter.ts` |
| `LiveCallController` | `application/live-call-controller.ts` |
| `LiveCallLatencyRecorder` | `application/live-call-latency.ts` |
| `PrototypeSystem` / `PrototypeCallSession` | `application/prototype-system.ts` |
| `SerialTaskQueue` | `application/serial-task-queue.ts` |

### Supervision lane — the brain, entirely off the audio path

| Node | File |
| --- | --- |
| `Supervisor` — authoritative `LeadState` | `application/supervisor.ts` |
| `ModelLeadUnderstandingAdapter` → `OpenAIResponsesLeadPatchClient` | `infrastructure/model-lead-understanding.ts`, `infrastructure/openai-responses-lead-client.ts` |
| `DeterministicLeadClassifier` | `domain/classifier.ts` |
| `LeadPolicy` | `domain/policy.ts` |
| `callback-time` — Asia/Kolkata resolver | `domain/callback-time.ts` |
| `negative-intent`, `language-choice`, `lead-state`, `replay` | `domain/` |
| `ConversationOrchestrator` — directive queue | `application/conversation-orchestrator.ts` |

### Action lane — the only place with outbound side effects

| Node | File |
| --- | --- |
| `ActionManager` — idempotency, bounded retry | `application/action-manager.ts` |
| `MessageComposer` | `application/message-composer.ts` |
| `OpenWAWhatsAppAdapter` / `MetaWhatsAppAdapter` | `infrastructure/*-whatsapp-adapter.ts` |
| `WebhookCallbackSchedulerAdapter` / `DurableSipCallbackScheduler` | `infrastructure/*callback*.ts` |

### Observability

| Node | File |
| --- | --- |
| `InMemoryEventStore` — normalized, per-call `seq` | `infrastructure/event-store.ts` |
| `SanitizedJsonlEventSink` → `logs/live-calls/*.jsonl` | `infrastructure/sanitized-jsonl-event-sink.ts` |
| `ConsoleSanitizedLogger` — hashed refs only | `infrastructure/sanitized-logger.ts` |

---

## 2. System context

Solid arrows carry data. Dotted arrows carry observation or control only. Note that
**no arrow crosses from the media plane into the control plane carrying audio** — the
only link between them is SIP signalling and the `call_id`-keyed control socket.

```mermaid
flowchart TB

    subgraph MP["🔊 MEDIA PLANE — audio never enters Node"]
        direction LR
        LEAD["Lead handset<br>PSTN"]
        ZAD["Zadarma<br>SIP trunk · auth by IP"]
        AST["Asterisk<br>PJSIP · mixing,proxy_media bridge"]
        OAI["OpenAI Realtime SIP<br>speech-to-speech model"]
        LEAD <--> |"RTP"| ZAD
        ZAD <--> |"SIP + RTP · alaw,ulaw"| AST
        AST <--> |"SIP + SRTP<br>both legs in one bridge"| OAI
    end

    subgraph CP["⚙️ CONTROL PLANE — ElevateBox Node process"]
        direction TB
        GW["LiveGatewayServer<br>/calls/prepare · /calls/dial<br>/webhooks/openai/realtime · /health"]
        WH["VerifiedOpenAIWebhookReceiver<br>raw-body HMAC · timestamp<br>webhook-id replay guard"]
        CO["AsteriskSipCallCoordinator<br>single-call state machine"]
        ARI["AsteriskAriAdapter<br>originate · silence · bridge · hangup"]
        SB["OpenAISipSidebandAdapter<br>media-free control socket, keyed by call_id"]
        LC["LiveCallController<br>turn reordering · directive flush · latency"]
    end

    subgraph SL["🧠 SUPERVISION LANE — parallel, nothing waits on it"]
        direction TB
        PCS["PrototypeCallSession<br>turn lane + action lane"]
        SV["Supervisor<br>authoritative LeadState · ordered apply slot"]
        UND["ModelLeadUnderstandingAdapter<br>OpenAI Responses · strict JSON Schema"]
        DOM["Domain — pure functions<br>classifier · policy · callback-time<br>negative-intent · language-choice"]
        ORC["ConversationOrchestrator<br>priority sort · dedupe by directiveId"]
    end

    subgraph AL["📤 ACTION LANE — SerialTaskQueue"]
        direction TB
        AM["ActionManager + MessageComposer<br>idempotency key · bounded retry"]
        WA["OpenWA REST<br>or Meta Cloud API"]
        SCH["Signed callback webhook<br>or DurableSipCallbackScheduler"]
    end

    subgraph OB["🗂 OBSERVABILITY"]
        direction TB
        ES["InMemoryEventStore<br>normalized · ordered · per-call seq"]
        JS["SanitizedJsonlEventSink<br>logs/live-calls/*.jsonl"]
        LG["ConsoleSanitizedLogger<br>hashed refs only"]
    end

    OP(["Operator or scheduler"]) --> |"Bearer token"| GW
    GW --> CO
    OAI -.-> |"realtime.call.incoming"| WH
    WH --> CO
    CO --> ARI
    ARI <--> |"ARI REST + WebSocket"| AST
    ARI -.-> |"telephony lifecycle"| CO
    CO --> SB
    SB <-.-> |"wss · v1/realtime?call_id=…<br>events + directives · zero PCM"| OAI

    SB -.-> |"VoiceRuntimeEvent"| LC
    LC --> |"stable turns"| PCS
    LC --> |"sendDirective when idle"| SB

    PCS --> SV
    PCS --> AM
    SV --> UND
    SV --> DOM
    SV --> ORC
    ORC -.-> |"takeDirectives"| LC
    AM --> WA
    AM --> SCH
    AM -.-> |"action lifecycle"| SV

    SV --> ES
    CO -.-> ES
    ES --> JS
    ES -.-> LG

    classDef media fill:#0f766e,stroke:#5eead4,stroke-width:2px,color:#ffffff
    classDef control fill:#1d4ed8,stroke:#93c5fd,stroke-width:2px,color:#ffffff
    classDef brain fill:#7c3aed,stroke:#c4b5fd,stroke-width:2px,color:#ffffff
    classDef action fill:#b45309,stroke:#fcd34d,stroke-width:2px,color:#ffffff
    classDef obs fill:#334155,stroke:#94a3b8,stroke-width:2px,color:#ffffff
    classDef ext fill:#4b5563,stroke:#d1d5db,stroke-width:2px,color:#ffffff

    class LEAD,ZAD,AST,OAI media
    class GW,WH,CO,ARI,SB,LC control
    class PCS,SV,UND,DOM,ORC brain
    class AM,WA,SCH action
    class ES,JS,LG obs
    class OP ext
```

### Why the audio path is short

`AsteriskAriAdapter` originates an OpenAI leg and a Zadarma leg and drops both into one
`mixing,proxy_media` bridge. From that moment the lead's voice reaches the model as RTP
through Asterisk and the model's voice returns the same way. ElevateBox holds a
**second, separate** WebSocket to OpenAI — the *sideband* — attached by `call_id`. It
carries transcripts, VAD signals and instruction updates. It never carries base64 PCM,
so no Node event-loop stall can ever become audible.

`AsteriskSipCallCoordinator.inspectFormats` reads the negotiated read/write formats off
both channels *after* bridging and logs `codecMatch`. The system reports what actually
happened rather than asserting zero transcoding.

---

## 3. Call establishment — prepare before dial

The lead's phone cannot ring until the AI leg is proven ready. That is enforced by a
server-held capability, not by convention: `/calls/dial` requires the exact, unexpired
token issued by `/calls/prepare`, and one token cannot dial twice.

```mermaid
sequenceDiagram
    autonumber
    participant OP as Operator · scheduler
    participant GW as LiveGatewayServer
    participant CO as SipCallCoordinator
    participant AR as Asterisk · ARI
    participant OA as OpenAI Realtime
    participant LD as Zadarma · Lead

    OP->>GW: POST /calls/prepare
    GW->>CO: prepare with SessionContext
    Note over CO: state PREPARING_AI · TTL armed
    CO->>AR: originateOpenAI
    AR->>OA: SIP INVITE
    Note over CO,AR: SIP Call-ID captured from the channel

    OA-->>GW: POST /webhooks/openai/realtime
    GW->>GW: verify HMAC over the raw body<br>timestamp check · webhook-id replay guard
    GW->>CO: realtime.call.incoming
    CO->>CO: correlate SIP Call-ID<br>unmatched or expired is rejected 603 and torn down
    CO->>OA: accept + attach sideband on call_id
    OA-->>CO: control session ready
    CO->>CO: startCall workflow · LiveCallController · latency recorder
    Note over CO: state AI_READY
    CO-->>GW: ready token · expiresAt · provider
    GW-->>OP: 201 with the capability

    OP->>GW: POST /calls/dial with that exact token
    GW->>CO: dial · idempotency key fingerprinted
    Note over CO: state DIALING_LEAD
    CO->>AR: startSilence on the AI leg
    Note over AR,OA: the model hears silence, not ringback
    CO->>AR: originateLead toward Zadarma
    AR->>LD: SIP INVITE
    LD-->>AR: answered
    CO->>AR: stopSilence · createBridge · addChannels
    Note over CO: state BRIDGED
    AR-->>OA: RTP now flows lead ↔ model
    CO->>OA: startConversation with the opening instruction
    OA-->>LD: first spoken turn
    CO->>CO: inspectFormats · log negotiated codecs
```

`startSilence` / `stopSilence` around the dial is the small detail that keeps the
handoff clean: the model is held quiet while the PSTN leg rings, then unmuted at the
exact moment the bridge exists.

---

## 4. The supervision feedback loop

This is the part that runs *in parallel* with the conversation. The speech-to-speech
model is never asked to wait for it.

```mermaid
sequenceDiagram
    autonumber
    participant LD as Lead
    participant OA as OpenAI speech-to-speech
    participant SB as Sideband socket
    participant LC as LiveCallController
    participant SV as Supervisor
    participant EX as Responses extraction
    participant OR as Orchestrator
    participant AQ as Action lane
    participant PR as WhatsApp · scheduler

    LD-->>OA: speech
    OA-->>LD: speech
    Note over LD,OA: this exchange never pauses for anything below

    OA-->>SB: user.turn.completed · turnId, transcript, turnSequence
    SB->>LC: normalized VoiceRuntimeEvent
    LC->>LC: buffer and drain in turnSequence order<br>skip empty and failed transcriptions
    LC->>SB: setPreferredLanguage if the lead named one
    LC->>SV: submitStableTurn

    par The call continues
        OA-->>LD: model keeps listening and speaking
    and Supervision runs off the audio path
        SV->>SV: reserve an ordered apply slot before the first await
        SV->>EX: understand · turn + preceding assistant line + accumulated state
        EX-->>SV: validated open-ended patch
        SV->>SV: await the previous turn's slot, then applyLeadUpdate
        SV->>SV: callback resolution · classify Hot/Warm/Cold · LeadPolicy
        SV->>OR: directives
        SV->>AQ: ActionCommands
    end

    LC->>OR: takeDirectives after the turn resolves
    OR-->>LC: priority sorted, deduped by directiveId
    LC->>SB: sendDirective · POST_CALL items are held back
    SB->>OA: instruction update only — no audio is injected
    OA-->>LD: the next natural turn already reflects it

    AQ->>PR: send or book · idempotency key · bounded retry
    PR-->>AQ: externalId
    AQ->>SV: action.succeeded
    SV->>OR: CONFIRM_ACTION_SUCCESS
    LC->>SB: second flush once actionsIdle
    OA-->>LD: "sent it to you on WhatsApp" — only now that it is true
```

### How it directs without interfering

Four mechanisms, all visible above:

1. **Text, never audio.** A `ConversationDirective` becomes a session instruction
   update on the sideband socket. The supervisor has no way to speak; only the model
   does.
2. **Delivery timing is part of the directive.** `IMMEDIATE_IF_IDLE`,
   `NEXT_NATURAL_TURN` and `POST_CALL` let the policy say *when* it may land.
   `LiveCallController.flushDirectives` drops everything once the voice leg has stopped.
3. **Priority and dedupe.** `ConversationOrchestrator` sorts by priority and refuses a
   `directiveId` it has already seen, so a repeated classification cannot nag.
4. **The ordered apply slot.** `Supervisor.processTurn` reserves its state-apply slot
   *before* the first `await`, so extraction requests can run concurrently while state
   is still applied strictly in transcript order. Turn 3 can never overwrite turn 4.

If extraction fails or times out, `lead.analysis.failed` is recorded, the slot is
released, and the call carries on. A degraded supervisor degrades the *lead record*,
not the conversation.

### How actions stay non-disruptive

`PrototypeCallSession` runs two independent lanes. Turn processing is a set of
concurrent promises; actions go onto a `SerialTaskQueue`. `ActionManager` keys every
command by `idempotencyKey`, returns the completed result for a repeat, joins an
in-flight duplicate rather than dispatching twice, and retries within `maxAttempts`.

Crucially, the model is only told about an action **after** the adapter returns.
`action.succeeded` triggers `CONFIRM_ACTION_SUCCESS`; `action.failed` triggers
`REPORT_ACTION_FAILURE` at priority 1. There is no optimistic announcement.

Live side effects sit behind explicit gates — `WHATSAPP_MODE`, `CALLBACK_MODE`,
`ALLOW_REAL_WHATSAPP_MESSAGES`, `ALLOW_UNOFFICIAL_WHATSAPP_CLIENT`,
`ALLOW_LIVE_CALLBACK_BOOKINGS`, `ALLOW_PAID_SIP_CALLS` — all blank by default, so the
whole graph runs end to end with no network egress.

---

## 5. Event logging

Every meaningful transition is appended to `InMemoryEventStore`, which assigns a
per-call monotonic `seq` and mirrors each event to `SanitizedJsonlEventSink`. Because
the log is normalized and ordered, `domain/replay.ts` can reconstruct `LeadState` from
events alone.

```mermaid
flowchart LR
    subgraph SRC["Emitters"]
        direction TB
        E1["Supervisor<br>turn.completed · lead.analysis.*<br>lead.state.updated · lead.classification.*<br>callback.* · conversation.directive · action.requested"]
        E2["ActionManager via Supervisor<br>action.started / succeeded / failed"]
        E3["SipCallCoordinator<br>sip_call.state_changed · openai_sip.*<br>call.latency_summary"]
    end

    ST["InMemoryEventStore<br>eventId · callId · seq · type<br>occurredAt · sourceTurnIds · payload"]
    SK["SanitizedJsonlEventSink"]
    FI[("logs/live-calls/*.jsonl<br>append-only, gitignored")]
    RP["domain/replay.ts<br>rebuild LeadState from events"]
    CL["ConsoleSanitizedLogger<br>hashed refs · bounded status fields"]

    E1 --> ST
    E2 --> ST
    E3 --> ST
    ST --> SK --> FI
    ST --> RP
    E3 -.-> CL

    classDef brain fill:#7c3aed,stroke:#c4b5fd,stroke-width:2px,color:#ffffff
    classDef control fill:#1d4ed8,stroke:#93c5fd,stroke-width:2px,color:#ffffff
    classDef obs fill:#334155,stroke:#94a3b8,stroke-width:2px,color:#ffffff
    class E1,E2,RP brain
    class E3 control
    class ST,SK,FI,CL obs
```

Two separate redaction levels: the JSONL sink strips transcripts and identifiers down
to safe shapes for analysis, while console logs carry only hashed call/destination
references and bounded status fields — never tokens, full phone numbers, media URLs or
provider bodies.

---

## 6. Call lifecycle

One preparing-or-active call at a time. The coordinator is the single owner of this
state machine; the gateway, the webhook receiver and ARI all funnel into it.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> PREPARING_AI: POST /calls/prepare
    PREPARING_AI --> AI_READY: webhook correlated, accepted, leg answered
    PREPARING_AI --> FAILED: TTL expiry or originate/accept error
    AI_READY --> DIALING_LEAD: POST /calls/dial with the exact token
    AI_READY --> FAILED: token expired or aborted
    DIALING_LEAD --> BRIDGED: lead answered, channels added
    DIALING_LEAD --> FAILED: no answer or originate error
    BRIDGED --> ENDED: either channel hangs up
    BRIDGED --> FAILED: sideband socket closed
    ENDED --> [*]
    FAILED --> [*]

    note right of PREPARING_AI
      Advances only on a signature-verified
      webhook whose SIP Call-ID matches this leg.
      An unknown Call-ID is rejected 603,
      a duplicate incoming call 486 — neither
      disturbs the pending preparation.
    end note

    note right of AI_READY
      A reused idempotency key with a different
      request fingerprint is rejected outright.
      An ambiguous dial is never auto-retried,
      because it may already be a paid call.
    end note

    note right of BRIDGED
      A sideband close is terminal even with
      close code 1000 — see the incident note.
    end note
```

Teardown is idempotent and always in the same order: mark state, stop the controller,
then settle bridge destroy, both hangups, OpenAI hangup and sideband close together,
then flush the latency summary into the event log.

---

## 7. Rollback route

The Exotel AgentStream path is retained behind `OUTBOUND_CALL_PROVIDER=exotel`. It is
the *only* configuration where audio passes through Node, which is exactly why it is
not the default.

```mermaid
flowchart LR
    EX["Exotel AgentStream"] <--> |"base64 PCM over WebSocket"| MED["/media/:token<br>single-use, TTL bound"]
    MED --> ECA["ExotelCallAdapter"]
    ECA <--> |"PCM frames"| RT["OpenAIRealtimeRuntime<br>direct Realtime WebSocket"]
    ECA -.-> |"same lifecycle events"| LCC["LiveCallController"]
    LCC --> SUP["Supervisor · unchanged"]

    classDef legacy fill:#4b5563,stroke:#d1d5db,stroke-width:2px,color:#ffffff
    classDef control fill:#1d4ed8,stroke:#93c5fd,stroke-width:2px,color:#ffffff
    classDef brain fill:#7c3aed,stroke:#c4b5fd,stroke-width:2px,color:#ffffff
    class EX,MED,ECA,RT legacy
    class LCC control
    class SUP brain
```

Both routes emit the same provider-neutral `TelephonyLifecycleObserver` events, so
`LiveCallController`, `Supervisor`, the domain layer and the action lane are byte-for-byte
identical across them. Swapping carriers changes the two adapters at the edge and
nothing else — which is the whole point of the `src/contracts.ts` seam.
