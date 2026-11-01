import { expect, test } from "bun:test";
import { scramFinal, scramFirstBare } from "../src/pgAuth";

// Test vector from RFC 7677 §3 (SCRAM-SHA-256). Verifies the computation without any database.
const NONCE = "rOprNGfwEbeRWgbNEkqO";
const SERVER_FIRST = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";

test("client-first-bare has the RFC shape", () => {
  expect(scramFirstBare(NONCE, "user")).toBe("n=user,r=rOprNGfwEbeRWgbNEkqO");
  // Postgres omits the name — it is already in the startup packet.
  expect(scramFirstBare(NONCE)).toBe("n=,r=rOprNGfwEbeRWgbNEkqO");
});

test("client proof matches the RFC 7677 vector", () => {
  const r = scramFinal("pencil", NONCE, SERVER_FIRST, "user");
  expect(r.clientFinal).toBe(
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
  );
});

test("server signature matches the RFC 7677 vector", () => {
  expect(scramFinal("pencil", NONCE, SERVER_FIRST, "user").serverSignature)
    .toBe("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
});

test("a different password gives a different proof", () => {
  expect(scramFinal("jine", NONCE, SERVER_FIRST).clientFinal)
    .not.toBe(scramFinal("pencil", NONCE, SERVER_FIRST).clientFinal);
});

test("server-first without the client nonce is rejected — protection against a spoofed server", () => {
  const cizi = "r=UPLNEJINYNONCE,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
  expect(() => scramFinal("pencil", NONCE, cizi)).toThrow(/nonce/i);
});
