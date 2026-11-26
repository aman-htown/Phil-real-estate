/**
 * Development transport: no WhatsApp connection. Outbound messages are logged
 * and receipts are simulated. Inject inbound messages from the web UI's
 * Status page ("Simulate an inbound message"), which writes straight to the DB.
 */
import { randomUUID } from "node:crypto";
import { log } from "../log";
import type { SendTarget, Transport, TransportHandlers } from "./types";

export class MockTransport implements Transport {
  readonly name = "mock";
  private handlers?: TransportHandlers;
  private timers = new Set<NodeJS.Timeout>();

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
    await handlers.onState("connected", {
      detail: "Mock transport: nothing is sent to WhatsApp. Use the simulator on the Status page.",
      account: "mock",
    });
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
  }

  async sendText(to: SendTarget, body: string): Promise<{ waMessageId: string }> {
    const waMessageId = `mock-${randomUUID()}`;
    log.info({ to: to.waId, body }, "[mock] would send WhatsApp message");
    this.later(1_000, () => this.handlers?.onStatus({ waMessageId, status: "delivered" }));
    this.later(3_000, () => this.handlers?.onStatus({ waMessageId, status: "read" }));
    return { waMessageId };
  }

  async markRead(): Promise<void> {}

  private later(ms: number, fn: () => Promise<void> | undefined) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      Promise.resolve(fn()).catch((err) => log.error({ err }, "[mock] status callback failed"));
    }, ms);
    this.timers.add(t);
  }
}
