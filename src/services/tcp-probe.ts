import net from "node:net";

export async function probeTcpHost(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finalize = (result: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finalize(true));
    socket.once("timeout", () => finalize(false));
    socket.once("error", () => finalize(false));
    socket.connect(port, host);
  });
}
