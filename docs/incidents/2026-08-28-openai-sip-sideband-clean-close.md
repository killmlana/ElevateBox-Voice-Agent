# OpenAI SIP sideband clean-close incident — 2026-08-28

## Symptom

A live SIP call reached `AI_READY` and `BRIDGED`. The model spoke its opening sentence, then stopped responding. The RTP bridge remained up until the lead hung up. The trace contained no speech, turn, or model-response events after setup, and the latency summary contained only SIP readiness and PSTN answer-to-bridge measurements.

## Root cause

`OpenAISipControlSession.handleClose()` ended its async event queue for every WebSocket close. After readiness, that made `for await (const event of conversation.events())` complete normally. `AsteriskSipCallCoordinator.forwardEvents()` handled only thrown iterator failures, so a normal completion left the call bridged with no sideband control channel and emitted no diagnostic log.

A WebSocket close code of 1000 is only a normal transport close frame. It is still unexpected while an ElevateBox call is `AI_READY`, `DIALING_LEAD`, or `BRIDGED`.

## Fix

- Application-initiated `conversation.close()` still ends the event iterator normally.
- Any transport close before or after readiness now fails the iterator with `OpenAISipSidebandClosedError`.
- The error records only the numeric close code and a hash of the provider close reason; raw provider text is not logged.
- The coordinator logs `openai_sip.sideband_closed` with the sanitized call reference, lifecycle state, close code, clean-code flag, and close-reason hash.
- As defense in depth, an event iterator that completes while the call is active logs both `openai_sip.sideband_event_stream_ended` and `sip_call.control_stream_closed`, and is also treated as a failure.
- Both paths terminate the call, destroy the bridge, hang up the Asterisk legs and OpenAI call, flush latency telemetry, and log `sip_call.failed`.

Automatic reconnection was deliberately not included. Reattaching to a live SIP session would require bounded retries plus safe replay of session configuration, language state, pending directives, response state, and cancellation state. Until that protocol is implemented and tested, failing loudly is safer than leaving a silent paid call or replaying application actions.

## Regression coverage

- The SIP adapter test forces a code-1000 close after readiness and asserts that the iterator rejects with sanitized close metadata.
- The coordinator test forces that failure while bridged and asserts `FAILED`, bridge destruction, both channel hangups, OpenAI hangup, and the new diagnostic event.
