import WebSocket, { type RawData } from "ws";

import type {
  RealtimeSocket,
  RealtimeSocketFactory,
} from "./openai-realtime-runtime.ts";

function messageText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export class NodeRealtimeSocketFactory implements RealtimeSocketFactory {
  connect(options: Parameters<RealtimeSocketFactory["connect"]>[0]): RealtimeSocket {
    const socket = new WebSocket(options.url, { headers: options.headers });
    socket.on("open", () => options.handlers.open());
    socket.on("message", (data) => options.handlers.message(messageText(data)));
    socket.on("error", (error) => options.handlers.error(error));
    socket.on("unexpected-response", (_request, response) => {
      options.handlers.error(
        new Error(
          `OpenAI Realtime WebSocket handshake returned HTTP ${response.statusCode}`,
        ),
      );
    });
    socket.on("close", (code, reason) =>
      options.handlers.close(code, reason.toString("utf8")),
    );
    return {
      send(data): void {
        socket.send(data);
      },
      close(code, reason): void {
        socket.close(code, reason);
      },
    };
  }
}
