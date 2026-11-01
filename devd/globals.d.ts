// Types from `hono/bun` (the WebSocket helper) reference the DOM `BinaryType`, which is not
// in the Bun/ESNext lib set (tsconfig `lib: ["ESNext"]`, `types: ["bun"]`). We declare it
// ambiently so `upgradeWebSocket` typechecks without enabling the whole DOM lib.
type BinaryType = "blob" | "arraybuffer";
