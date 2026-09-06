/**
 * Herkunft eines Aufrufs für das Sicherheitsprotokoll.
 *
 * Geprüft wird die einzige Funktion in audit.ts, die ohne Datenbank auskommt —
 * und die, an der die interessanteste Zeile des Protokolls hängt: eine Reihe
 * fehlgeschlagener Anmeldungen ist nur dann etwas wert, wenn dabei steht,
 * von wo sie kam.
 *
 * Ausführen: cd backend && bun test src/service/audit.test.ts
 */
import { expect, test, describe } from "bun:test";
import { herkunft } from "./audit.ts";

describe("herkunft", () => {
  test("nimmt die erste Adresse aus x-forwarded-for", () => {
    // nginx hängt an, statt zu ersetzen: der Client steht vorn, dahinter die
    // Proxys. Wer die letzte nähme, protokollierte die eigene Infrastruktur.
    const h = new Headers({
      "x-forwarded-for": "203.0.113.7, 10.0.0.3, 10.0.0.1",
      "user-agent": "Mozilla/5.0",
    });
    expect(herkunft(h)).toEqual({
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0",
    });
  });

  test("fällt auf x-real-ip zurück", () => {
    const h = new Headers({ "x-real-ip": "198.51.100.9" });
    expect(herkunft(h).ip).toBe("198.51.100.9");
  });

  test("ohne Kopfzeilen null statt leerer Zeichenkette", () => {
    // null heißt „nicht bekannt". Eine leere Zeichenkette sähe in der Tabelle
    // wie eine gemessene Angabe aus.
    expect(herkunft(new Headers())).toEqual({ ip: null, userAgent: null });
  });

  test("kürzt einen absurd langen User-Agent", () => {
    const h = new Headers({ "user-agent": "A".repeat(2000) });
    expect(herkunft(h).userAgent).toHaveLength(512);
  });

  test("liest auch aus einem Hono-Request", () => {
    // Die Router übergeben `c.req`, die Better-Auth-Hooks ein Headers-Objekt.
    const req = {
      header: (name: string) =>
        name === "x-forwarded-for" ? "192.0.2.44" : undefined,
    };
    expect(herkunft(req as never).ip).toBe("192.0.2.44");
  });
});
