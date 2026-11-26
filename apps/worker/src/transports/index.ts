import type { TransportName } from "../config";
import type { Transport } from "./types";

export async function createTransport(name: TransportName): Promise<Transport> {
  switch (name) {
    case "cloud": {
      const { CloudTransport } = await import("./cloud");
      return new CloudTransport();
    }
    case "web": {
      // Loaded lazily so Baileys is only initialised when used.
      const { WebTransport } = await import("./web");
      return new WebTransport();
    }
    case "mock": {
      const { MockTransport } = await import("./mock");
      return new MockTransport();
    }
  }
}

export * from "./types";
