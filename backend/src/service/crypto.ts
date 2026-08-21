/**
 * Verschlüsselung für Geheimnisse, die die Anwendung **im Klartext brauchen**
 * wird — heute genau eines: die API-Schlüssel fremder LLM-Anbieter.
 *
 * ## Warum nicht einfach hashen
 *
 * Weil ein Hash nicht rückrechenbar ist, und genau das ist hier nötig: der
 * Schlüssel geht als `Authorization: Bearer …` an den Anbieter. Passwörter
 * werden gehasht, weil niemand sie zurückbekommen muss; ein fremder API-Schlüssel
 * muss zurückgeholt werden. Also Verschlüsselung, nicht Hashing.
 *
 * ## Was das schützt und was nicht
 *
 * Geschützt wird gegen **Preisgabe der Datenbank**: das nächtliche `pg_dumpall`
 * liegt auf derselben Platte wie die Datenbank (`platform/deploy/pg-shared`),
 * und die Spalte hieß bislang `api_key_encrypted`, enthielt aber Klartext. Wer
 * den Dump hatte, hatte die Schlüssel — bei eigenen Schlüsseln eine Formsache,
 * bei den Schlüsseln von Kunden ein Vorfall.
 *
 * **Nicht** geschützt wird gegen jemanden, der den laufenden Server hat: der
 * Schlüssel steht in `AUTH_SECRET` in derselben `.env`. Das ist keine Nachlässigkeit,
 * sondern die Grenze jeder Verschlüsselung in einer Anwendung, die ohne
 * Menschen am Terminal starten muss. Wer mehr will, braucht ein
 * Schlüsselverwaltungssystem außerhalb dieser Maschine — das wäre bei einem
 * Server für sechs Apps mehr Zeremonie als Sicherheit.
 *
 * ## Format
 *
 * `enc:v1:<iv>:<tag>:<ciphertext>`, alle Teile Base64. Die Versionsnummer ist
 * kein Schmuck: sie erlaubt später ein anderes Verfahren, ohne die Bestandsdaten
 * zu erraten. Das Präfix erlaubt zugleich, **Klartext zu erkennen** — siehe
 * `entschlüssele`.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const PRÄFIX = "enc:v1:";

let schlüsselCache: Buffer | null = null;

/**
 * Leitet den 32-Byte-Schlüssel aus `AUTH_SECRET` ab.
 *
 * HKDF mit eigenem `info`-Feld statt `AUTH_SECRET` direkt: derselbe Wert
 * signiert auch die Sitzungscookies (Better Auth). Zwei Verwendungen desselben
 * Rohgeheimnisses sind eine Schwäche, die nichts kostet zu vermeiden — der
 * abgeleitete Schlüssel lässt keinen Rückschluss auf den Cookie-Schlüssel zu.
 */
function schlüssel(): Buffer {
  if (schlüsselCache) return schlüsselCache;
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET fehlt – ohne ihn lassen sich die API-Schlüssel nicht ent-/verschlüsseln",
    );
  }
  schlüsselCache = Buffer.from(
    hkdfSync("sha256", secret, "prowiki-provider-keys", "model_providers.api_key", 32),
  );
  return schlüsselCache;
}

/** Verschlüsselt einen Wert. Das Ergebnis beginnt immer mit `enc:v1:`. */
export function verschlüssele(klartext: string): string {
  const iv = randomBytes(12); // GCM will 96 Bit
  const c = createCipheriv("aes-256-gcm", schlüssel(), iv);
  const ct = Buffer.concat([c.update(klartext, "utf8"), c.final()]);
  return (
    PRÄFIX +
    [iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(
      ":",
    )
  );
}

/** Erkennt, ob ein gespeicherter Wert verschlüsselt ist. */
export function istVerschlüsselt(wert: string): boolean {
  return wert.startsWith(PRÄFIX);
}

/**
 * Entschlüsselt einen gespeicherten Wert.
 *
 * **Klartext wird durchgelassen**, nicht abgelehnt. Das ist die Brücke über den
 * Bestand: als diese Datei entstand, lagen die Schlüssel unverschlüsselt in der
 * Tabelle. Ein `entschlüssele`, das darauf mit einem Fehler antwortet, hätte
 * Chat und Generierung sofort beendet — und zwar auf dem laufenden Server, vor
 * dem Migrationslauf. Stattdessen: durchlassen und einmal warnen.
 *
 * Der Klartextpfad ist damit ausdrücklich eine **Übergangsregelung**. Wenn
 * `scripts/encrypt-provider-keys.ts` gelaufen ist und keine Warnung mehr
 * erscheint, kann er weg.
 */
let klartextGewarnt = false;
export function entschlüssele(gespeichert: string): string {
  if (!istVerschlüsselt(gespeichert)) {
    if (!klartextGewarnt) {
      klartextGewarnt = true;
      console.warn(
        "[crypto] Mindestens ein API-Schlüssel liegt im Klartext in model_providers. " +
          "Einmalig beheben mit: bun run src/scripts/encrypt-provider-keys.ts",
      );
    }
    return gespeichert;
  }
  const teile = gespeichert.slice(PRÄFIX.length).split(":");
  if (teile.length !== 3) {
    throw new Error("Verschlüsselter Wert hat ein unerwartetes Format");
  }
  const [ivB64, tagB64, ctB64] = teile;
  const d = createDecipheriv(
    "aes-256-gcm",
    schlüssel(),
    Buffer.from(ivB64, "base64"),
  );
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    d.update(Buffer.from(ctB64, "base64")),
    d.final(),
  ]).toString("utf8");
}
