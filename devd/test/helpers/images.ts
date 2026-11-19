// Minimal image headers (enough for sniffing and reading the size), padded to `pad` bytes.
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const padTo = (bytes: number[], pad: number) => {
  const out = new Uint8Array(Math.max(pad, bytes.length));
  out.set(bytes);
  return out;
};

export const png = (w: number, h: number, pad = 0) =>
  padTo([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii("IHDR"), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0], pad);
// SOI, an APP0 segment to skip, then SOF0 with the size.
export const jpeg = (w: number, h: number, pad = 0) =>
  padTo([0xff, 0xd8, 0xff, 0xe0, ...u16be(4), 0, 0, 0xff, 0xc0, ...u16be(11), 8, ...u16be(h), ...u16be(w), 1, 1, 0x11, 0], pad);
export const gif = (w: number, h: number, pad = 0) => padTo([...ascii("GIF89a"), ...u16le(w), ...u16le(h), 0, 0, 0], pad);
export const webp = (w: number, h: number, pad = 0) =>
  padTo([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)], pad);
