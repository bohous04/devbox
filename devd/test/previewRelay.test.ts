import { expect, test } from "bun:test";
import { join } from "node:path";
import net from "node:net";

const RELAY = join(import.meta.dir, "..", "..", "image", "preview-relay");

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  });
}

test("preview-relay forwards TCP to 127.0.0.1:target", async () => {
  const target = await freePort();
  const listen = await freePort();
  // target echo server on 127.0.0.1:target
  const echo = net.createServer((c) => c.pipe(c));
  await new Promise<void>((r) => echo.listen(target, "127.0.0.1", r));
  const relay = Bun.spawn(["bun", RELAY, String(listen), String(target)], { stdout: "ignore", stderr: "ignore" });
  try {
    // wait until the relay starts listening
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      up = await new Promise<boolean>((res) => {
        const c = net.connect(listen, "127.0.0.1");
        c.on("connect", () => { c.destroy(); res(true); });
        c.on("error", () => res(false));
      });
      if (!up) await Bun.sleep(50);
    }
    expect(up).toBe(true);
    const got = await new Promise<string>((res, rej) => {
      const c = net.connect(listen, "127.0.0.1");
      let buf = "";
      c.on("connect", () => c.write("ahoj"));
      c.on("data", (d) => { buf += d.toString(); c.destroy(); res(buf); });
      c.on("error", rej);
    });
    expect(got).toBe("ahoj");
  } finally {
    relay.kill();
    echo.close();
  }
});
