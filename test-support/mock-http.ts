import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

export function createMockIncomingRequest(chunks: string[]): IncomingMessage {
  const request = new Readable({
    read() {
      for (const chunk of chunks) {
        this.push(chunk);
      }
      this.push(null);
    },
  }) as IncomingMessage;

  request.headers = {};
  request.method = "GET";
  request.url = "/";
  return request;
}

export type MockServerResponse = ServerResponse & {
  body?: string;
  sentHeaders: Record<string, string>;
};

export function createMockServerResponse(): MockServerResponse {
  const sentHeaders: Record<string, string> = {};
  const response = {
    statusCode: 200,
    headersSent: false,
    sentHeaders,
    setHeader(name: string, value: string) {
      sentHeaders[name.toLowerCase()] = value;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk != null) {
        response.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      }
      response.headersSent = true;
      return this;
    },
  };

  return response as unknown as MockServerResponse;
}
