import assert from "node:assert/strict";
import test from "node:test";

import { loadProductionConfig } from "../src/production-config.ts";

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    CONTROL_API_TOKEN: "control-token-at-least-sixteen",
    LEAD_PHONE: "+919876543210",
  };
}

test("production configuration defaults every external side effect to dry run", () => {
  const config = loadProductionConfig(baseEnvironment());
  assert.equal(config.mode, "dry-run");
  assert.equal(config.outboundCallProvider, "asterisk-sip");
  assert.equal(config.sipDialMode, "dry-run");
  assert.equal(config.allowPaidSipCalls, false);
  assert.equal(config.asterisk.zadarmaEndpoint, "zadarma");
  assert.equal(config.exotelDialMode, "dry-run");
  assert.equal(config.whatsappMode, "dry-run");
  assert.equal(config.whatsappProvider, "openwa");
  assert.equal(config.callbackMode, "dry-run");
  assert.equal(config.callbackProvider, "webhook");
  assert.equal(config.allowPaidExotelCalls, false);
  assert.equal(config.allowRealWhatsappMessages, false);
  assert.equal(config.allowUnofficialWhatsappClient, false);
  assert.equal(config.allowLiveCallbackBookings, false);
  assert.equal(config.openai.apiKey, undefined);
  assert.equal(config.openai.transcriptionModel, "gpt-live-transcribe");
  assert.equal(config.openai.realtimeVoice, "sage");
  assert.equal(config.traceDirectory, "logs/live-calls");
  assert.equal(config.publicMediaBaseUrl, undefined);
});

test("automatic callbacks require the live Asterisk SIP path", () => {
  assert.throws(
    () => loadProductionConfig({
      ...baseEnvironment(),
      ELEVATEBOX_MODE: "live",
      OPENAI_API_KEY: "test-openai-key",
      CALLBACK_MODE: "live",
      CALLBACK_PROVIDER: "automatic-sip",
      ALLOW_LIVE_CALLBACK_BOOKINGS: "I_UNDERSTAND_THIS_CREATES_REAL_CALLBACKS",
    }),
    /live Asterisk SIP dialing/,
  );
});

test("live Zadarma through Asterisk requires its paid-call gate and private ARI configuration", () => {
  assert.throws(
    () => loadProductionConfig({
      ...baseEnvironment(),
      ELEVATEBOX_MODE: "live",
      OPENAI_API_KEY: "test-openai-key",
      SIP_DIAL_MODE: "live",
    }),
    /ALLOW_PAID_SIP_CALLS/,
  );
  const liveBase = {
    ...baseEnvironment(),
    ELEVATEBOX_MODE: "live",
    OPENAI_API_KEY: "test-openai-key",
    SIP_DIAL_MODE: "live",
    ALLOW_PAID_SIP_CALLS: "I_UNDERSTAND_THIS_MAKES_PAID_CALLS",
    OPENAI_PROJECT_ID: "proj_elevatebox",
    OPENAI_WEBHOOK_SECRET: "whsec_test",
    ASTERISK_ARI_USERNAME: "elevatebox",
    ASTERISK_ARI_PASSWORD: "strong-password",
  };
  assert.throws(
    () => loadProductionConfig({
      ...liveBase,
      ASTERISK_ARI_BASE_URL: "http://asterisk.example.com:8088/ari",
    }),
    /loopback/,
  );
  const config = loadProductionConfig(liveBase);
  assert.equal(config.outboundCallProvider, "asterisk-sip");
  assert.equal(config.sipDialMode, "live");
  assert.equal(config.asterisk.callerId, undefined);
  assert.equal(config.openai.projectId, "proj_elevatebox");
});

test("live WhatsApp and callback booking require independent acknowledgements", () => {
  assert.throws(
    () => loadProductionConfig({
      ...baseEnvironment(),
      WHATSAPP_MODE: "live",
    }),
    /ALLOW_REAL_WHATSAPP_MESSAGES/,
  );
  assert.throws(
    () => loadProductionConfig({
      ...baseEnvironment(),
      CALLBACK_MODE: "live",
    }),
    /ALLOW_LIVE_CALLBACK_BOOKINGS/,
  );
});

test("OpenWA is primary and live OpenWA requires its additional risk acknowledgement", () => {
  assert.throws(
    () => loadProductionConfig({
      ...baseEnvironment(),
      OUTBOUND_CALL_PROVIDER: "exotel",
      ELEVATEBOX_MODE: "live",
      PUBLIC_MEDIA_BASE_URL: "wss://voice.example.com",
      OPENAI_API_KEY: "test-openai-key",
      WHATSAPP_MODE: "live",
      ALLOW_REAL_WHATSAPP_MESSAGES: "I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES",
    }),
    /ALLOW_UNOFFICIAL_WHATSAPP_CLIENT/,
  );
  const meta = loadProductionConfig({
    ...baseEnvironment(),
    WHATSAPP_PROVIDER: "meta",
  });
  assert.equal(meta.whatsappProvider, "meta");
});

test("live Exotel requires both live AI mode and an explicit paid-call acknowledgement", () => {
  assert.throws(
    () => loadProductionConfig({
      ...baseEnvironment(),
      OUTBOUND_CALL_PROVIDER: "exotel",
      EXOTEL_DIAL_MODE: "live",
    }),
    /ALLOW_PAID_EXOTEL_CALLS/,
  );
  assert.throws(
    () => loadProductionConfig({
      ...baseEnvironment(),
      OUTBOUND_CALL_PROVIDER: "exotel",
      EXOTEL_DIAL_MODE: "live",
      ALLOW_PAID_EXOTEL_CALLS: "I_UNDERSTAND_THIS_MAKES_PAID_CALLS",
    }),
    /ELEVATEBOX_MODE must be live/,
  );
});

test("live mode rejects insecure media and missing provider credentials", () => {
  assert.throws(
    () => loadProductionConfig({
      ...baseEnvironment(),
      OUTBOUND_CALL_PROVIDER: "exotel",
      ELEVATEBOX_MODE: "live",
      PUBLIC_MEDIA_BASE_URL: "ws://voice.example.com",
    }),
    /wss:\/\//,
  );
  assert.throws(
    () => loadProductionConfig({
      ...baseEnvironment(),
      ELEVATEBOX_MODE: "live",
      PUBLIC_MEDIA_BASE_URL: "wss://voice.example.com",
    }),
    /OPENAI_API_KEY/,
  );
});
