import EventEmitter from "events";
import { IncomingMessage, STATUS_CODES } from "http";
import { WebSocket } from "isomorphic-ws";
import {
  C2SRequestTypes,
  HTTPRequestPayload,
  HTTPResponsePayload,
  ProtoBareHeaders,
  S2CRequestType,
  S2CRequestTypes,
  S2CWSClosePayload,
} from "protocol";
import { Readable } from "stream";
import { BareError, bareFetch, options } from "./http";

function bareErrorToResponse(e: BareError): {
  payload: HTTPResponsePayload;
  body: AsyncIterable<ArrayBuffer>;
} {
  return {
    payload: {
      status: e.status,
      statusText: STATUS_CODES[e.status] || "",
      headers: {},
    },
    body: Readable.from(JSON.stringify(e.body)),
  };
}

export class AdriftServer {
  send: (msg: ArrayBuffer) => void;
  sockets: Record<number, WebSocket> = {};
  events: EventEmitter;

  constructor(send: (msg: ArrayBuffer) => void) {
    this.send = send;
    this.events = new EventEmitter();
  }

  static parseMsgInit(
    msg: ArrayBuffer
  ): { cursor: number; seq: number; op: number } | undefined {
    try {
      console.log(msg);
      const dataView = new DataView(msg);
      let cursor = 0;
      const seq = dataView.getUint16(cursor);
      cursor += 2;
      const op = dataView.getUint8(cursor);
      cursor += 1;
      return { cursor, seq, op };
    } catch (e) {
      if (e instanceof RangeError) {
        // malformed message
        return;
      }
      throw e;
    }
  }

  static tryParseJSONPayload(payloadRaw: ArrayBuffer): any | undefined {
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(payloadRaw));
    } catch (e) {
      if (e instanceof SyntaxError) {
        return;
      }
      throw e;
    }
    console.log({ payload });
    return payload;
  }

  async handleHTTPRequest(payload: HTTPRequestPayload): Promise<{
    payload: HTTPResponsePayload;
    body: AsyncIterable<ArrayBuffer>;
  }> {
    const abort = new AbortController();
    const onClose = () => {
      abort.abort();
      this.events.off("close", onClose);
    };
    this.events.on("close", onClose);

    let resp: IncomingMessage;
    try {
      resp = await bareFetch(
        payload,
        abort.signal,
        new URL(payload.remote),
        options
      );
    } catch (e) {
      if (e instanceof BareError) {
        return bareErrorToResponse(e);
      }
      this.events.off("close", onClose);
      throw e;
    }

    this.events.off("close", onClose);

    return {
      payload: {
        status: resp.statusCode || 500,
        statusText: resp.statusMessage || "",
        headers: Object.fromEntries(
          Object.entries(resp.headersDistinct).filter(([_k, v]) => Boolean(v))
        ) as ProtoBareHeaders,
      },
      body: resp,
    };
  }

  _sendJSONRes(seq: number, op: S2CRequestType, payload: any) {
    const payloadBuffer = new TextEncoder().encode(JSON.stringify(payload));
    const buf = new ArrayBuffer(2 + 1 + payloadBuffer.length);
    const dataView = new DataView(buf);
    let cursor = 0;
    dataView.setUint16(cursor, seq);
    cursor += 2;
    dataView.setUint8(cursor, op);
    cursor += 1;
    new Uint8Array(buf).set(payloadBuffer, cursor);
    this.send(buf);
  }

  sendHTTPResponseStart(seq: number, payload: HTTPResponsePayload) {
    this._sendJSONRes(seq, S2CRequestTypes.HTTPResponseStart, payload);
  }

  sendHTTPResponseChunk(seq: number, chunk: Uint8Array) {
    const buf = new ArrayBuffer(2 + 1 + chunk.byteLength);
    const dataView = new DataView(buf);
    let cursor = 0;
    dataView.setUint16(cursor, seq);
    cursor += 2;
    dataView.setUint8(cursor, S2CRequestTypes.HTTPResponseChunk);
    cursor += 1;
    new Uint8Array(buf).set(chunk, cursor);
    this.send(buf);
  }

  _sendSimpleRes(seq: number, op: S2CRequestType) {
    const buf = new ArrayBuffer(2 + 1);
    const dataView = new DataView(buf);
    let cursor = 0;
    dataView.setUint16(cursor, seq);
    cursor += 2;
    dataView.setUint8(cursor, op);
    this.send(buf);
  }

  sendHTTPResponseEnd(seq: number) {
    this._sendSimpleRes(seq, S2CRequestTypes.HTTPResponseEnd);
  }

  sendWSOpen(seq: number) {
    this._sendSimpleRes(seq, S2CRequestTypes.WSOpen);
  }

  sendWSClose(seq: number, payload: S2CWSClosePayload) {
    this._sendJSONRes(seq, S2CRequestTypes.WSClose, payload);
  }

  sendWSText(seq: number, textEncoded: ArrayBuffer) {
    const buf = new ArrayBuffer(2 + 1 + textEncoded.byteLength);
    const dataView = new DataView(buf);
    let cursor = 0;
    dataView.setUint16(cursor, seq);
    cursor += 2;
    dataView.setUint8(cursor, S2CRequestTypes.WSDataText);
    cursor += 1;
    new Uint8Array(buf).set(new Uint8Array(textEncoded), cursor);
    this.send(buf);
  }

  sendWSBinary(seq: number, msg: ArrayBuffer) {
    const buf = new ArrayBuffer(2 + 1 + msg.byteLength);
    const dataView = new DataView(buf);
    let cursor = 0;
    dataView.setUint16(cursor, seq);
    cursor += 2;
    dataView.setUint8(cursor, S2CRequestTypes.WSDataBinary);
    cursor += 1;
    new Uint8Array(buf).set(new Uint8Array(msg), cursor);
    this.send(buf);
  }

  async onMsg(msg: ArrayBuffer) {
    const init = AdriftServer.parseMsgInit(msg);
    if (!init) return;
    const { cursor, seq, op } = init;
    switch (op) {
      case C2SRequestTypes.HTTPRequest: {
        let resp: {
          payload: HTTPResponsePayload;
          body: AsyncIterable<ArrayBuffer>;
        };
        const reqPayload = AdriftServer.tryParseJSONPayload(msg.slice(cursor));
        if (!reqPayload) return;
        try {
          resp = await this.handleHTTPRequest(reqPayload);
        } catch (e) {
          if (options.logErrors) console.error(e);

          let bareError;
          if (e instanceof BareError) {
            bareError = e;
          } else if (e instanceof Error) {
            bareError = new BareError(500, {
              code: "UNKNOWN",
              id: `error.${e.name}`,
              message: e.message,
              stack: e.stack,
            });
          } else {
            bareError = new BareError(500, {
              code: "UNKNOWN",
              id: "error.Exception",
              message: "Error: " + e,
              stack: new Error(<string | undefined>e).stack,
            });
          }

          resp = bareErrorToResponse(bareError);
        }

        const { payload, body } = resp;
        this.sendHTTPResponseStart(seq, payload);
        for await (const chunk of body) {
          this.sendHTTPResponseChunk(seq, new Uint8Array(chunk));
        }
        this.sendHTTPResponseEnd(seq);
        break;
      }

      case C2SRequestTypes.WSOpen: {
        const payload = AdriftServer.tryParseJSONPayload(msg.slice(cursor));
        const ws = (this.sockets[seq] = new WebSocket(payload.url));
        ws.binaryType = "arraybuffer";
        // TODO v important: onerror
        ws.onopen = () => {
          this.sendWSOpen(seq);
        };
        ws.onclose = (e) => {
          this.sendWSClose(seq, {
            code: e.code,
            reason: e.reason,
            wasClean: e.wasClean,
          });
        };
        (ws as any).onmessage = (
          dataOrEvent: ArrayBuffer | MessageEvent<any>,
          isBinary?: boolean
        ) => {
          // we have to carefully handle two websocket libraries here
          // node ws: first arg is Buffer|ArrayBuffer|Buffer[] depending on binaryType,
          //  2nd arg is isBinary
          // web ws: first arg is an event, event.data is string if text or
          //  arraybuffer|blob depending on binaryType.
          if (dataOrEvent instanceof ArrayBuffer) {
            if (isBinary) {
              this.sendWSBinary(seq, dataOrEvent);
              return;
            }
            this.sendWSText(seq, dataOrEvent);
            return;
          }
          // unless we set binaryType incorrectly, we should be on the web here.
          if (typeof dataOrEvent.data === "string") {
            this.sendWSText(seq, new TextEncoder().encode(dataOrEvent.data));
            return;
          }
          if (dataOrEvent.data instanceof ArrayBuffer) {
            this.sendWSBinary(seq, dataOrEvent.data);
            return;
          }
          console.error({ dataOrEvent, isBinary });
          throw new Error("Unexpected message type received");
        };
        break;
      }

      case C2SRequestTypes.WSSendText: {
        const socket = this.sockets[seq];
        if (!socket) return;
        socket.send(new TextDecoder().decode(msg.slice(cursor)));
        break;
      }

      case C2SRequestTypes.WSSendBinary: {
        const socket = this.sockets[seq];
        if (!socket) return;
        socket.send(msg.slice(cursor));
        break;
      }

      case C2SRequestTypes.WSClose: {
        const socket = this.sockets[seq];
        if (!socket) return;
        socket.close();
        break;
      }

      default:
        // not implemented
        break;
    }
  }

  onClose() {
    this.events.emit("close");
  }
}