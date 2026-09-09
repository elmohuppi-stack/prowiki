/**
 * Die Actor-Kette des Apify-Providers.
 *
 * Geprüft wird das Verhalten, das die Fehler ausgelöst hat, die diese Tests
 * veranlasst haben — alle drei an einem einzigen Video (NC6HhBQj4Ws, ein
 * deutschsprachiges Gespräch mit automatischen deutschen Untertiteln):
 *
 *   1. codepoetry antwortete mit Metadaten *und*
 *      `error: "No captions found. AI transcription is turned off."`. Die
 *      Kette endete daraufhin — die weiteren Actors und der AI-Rückfall kamen
 *      nie zum Einsatz, und der Import legte ein Dokument mit Titel, aber null
 *      Zeichen Transkript an.
 *   2. Die beiden Rückfall-Actors hatten falsch benannte Eingabefelder und
 *      antworteten seit immer nur mit HTTP 400 — der Kettenabbruch fiel
 *      deshalb nicht auf.
 *   3. Aus der Antwort von scrape-creators wurde das Segment-*Array* als Text
 *      gelesen: im Dokument stand "[object Object],[object Object],…".
 *
 * `fetch` ist gefälscht — kein Netz, kein Apify-Guthaben.
 *
 * Ausführen: cd backend && bun test src/service/youtube/apify.test.ts
 */
import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { ApifyProvider } from "./apify.ts";

const echtesFetch = globalThis.fetch;

/** Antworten in der Reihenfolge, in der die Actors gefragt werden. */
function fetchMit(antworten: unknown[][]) {
  const gefragt: { url: string; input: any }[] = [];
  let n = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    gefragt.push({
      url: String(url),
      input: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const body = antworten[n] ?? [];
    n++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return gefragt;
}

let gefragt: { url: string; input: any }[] = [];

beforeEach(() => {
  gefragt = [];
});
afterEach(() => {
  globalThis.fetch = echtesFetch;
  delete process.env.APIFY_AI_FALLBACK;
  delete process.env.APIFY_AI_MAX_MINUTES;
});

/**
 * Antwortform von johnvc/YoutubeTranscripts, gekürzt aus dem echten Lauf zu
 * NC6HhBQj4Ws. `timestamped` führt Sekunden mit Nachkommastellen.
 */
const JOHNVC = [
  {
    video_id: "NC6HhBQj4Ws",
    language: "German (auto-generated)",
    language_code: "de",
    is_generated: true,
    source_type: "Auto-generated",
    non_timestamped: "Hallo und herzlich willkommen lieber Daniele.",
    timestamped: [
      { text: "Hallo und herzlich willkommen lieber", start: 0.32, duration: 4.72 },
      { text: "Daniele.", start: 5.04, duration: 2.16 },
    ],
    title: "Wie ernst ist die Lage? Salim Samatou im Gespräch mit Dr. Daniele Ganser",
    channel_name: "Daniele Ganser",
    channel_url: "https://www.youtube.com/channel/UCgrHgV7atBftQk8dXwIDktg",
    video_duration_seconds: 5605,
    thumbnail_url: "https://i.ytimg.com/vi/NC6HhBQj4Ws/maxresdefault.jpg",
    upload_date: "2026-09-08",
    tags: ["Daniele Ganser", "Salim Samatou"],
    description: "Am 6.9.2026 habe ich mich mit Salim Samatou in Basel getroffen.",
    success: true,
  },
];

/** codepoetry-Antwort mit Metadaten, aber ohne Transkript. */
const OHNE_UNTERTITEL = [
  {
    metadata: { title: "Wie ernst ist die Lage?", channel: "Daniele Ganser" },
    error: "No captions found. AI transcription is turned off.",
    error_code: "no_captions",
    available_languages: ["de", "en-US"],
  },
];

describe("johnvc/YoutubeTranscripts als erster Actor", () => {
  test("liefert Transkript, Zeitmarken und Metadaten aus einem Aufruf", async () => {
    gefragt = fetchMit([JOHNVC]);

    const r = await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws");

    expect(gefragt.length).toBe(1);
    expect(gefragt[0].url).toContain("johnvc~YoutubeTranscripts");
    expect(r.transcript?.content).toBe("Hallo und herzlich willkommen lieber Daniele.");
    expect(r.transcript?.language).toBe("de");
    expect(r.transcript?.source).toBe("auto_generated");
    expect(r.metadata?.channelName).toBe("Daniele Ganser");
    expect(r.metadata?.duration).toBe(5605);
    expect(r.metadata?.publishedAt).toBe("2026-09-08");
    expect(r.metadata?.tags?.length).toBe(2);
  });

  test("rechnet die Sekunden der Zeitmarken in Millisekunden um", async () => {
    // start: 0.32 → 320 ms. Die Nachkommastellen sind das Signal für
    // Sekunden; als Millisekunden gelesen wäre das Transkript um den Faktor
    // 1000 gestaucht und jeder Videolink zeigte auf Sekunde 0.
    fetchMit([JOHNVC]);

    const r = await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws");

    expect(r.transcript?.segments?.length).toBe(2);
    expect(r.transcript?.segments?.[0]).toMatchObject({
      start_ms: 320,
      end_ms: 5040,
    });
  });

  test("fragt die gewünschte Sprache an und übersetzt nie", async () => {
    // `translate_to` darf nicht gesetzt sein: eine Übersetzung ist kein
    // Transkript, und genau so kam für dieses deutsche Video vorher ein
    // englischer Text ins Dokument.
    gefragt = fetchMit([JOHNVC]);

    await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws", "de");

    expect(gefragt[0].input.languages).toEqual(["de", "en"]);
    expect(gefragt[0].input.translate_to).toBeUndefined();
    expect(gefragt[0].input.transcript_type).toBe("any");
  });

  test("ein Fehlschlag wird an success erkannt, nicht nur am Fehlerfeld", async () => {
    // Zweite Antwort in der Form, die der zweite Actor (codepoetry) liest —
    // sonst prüfte der Test nur, dass die ganze Kette durchläuft.
    gefragt = fetchMit([
      [{ video_id: "x", success: false, error: "no transcript" }],
      [{ transcript_text: "vom zweiten Actor", language: "de" }],
    ]);

    const r = await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws");

    expect(gefragt.length).toBe(2);
    expect(r.transcript?.content).toBe("vom zweiten Actor");
  });
});

describe("Kettenverhalten", () => {
  test("fragt den nächsten Actor, wenn einer kein Transkript liefert", async () => {
    gefragt = fetchMit([
      [],
      OHNE_UNTERTITEL,
      [{ transcript_text: "vom dritten Actor", language: "de" }],
    ]);

    const r = await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws");

    expect(r.transcript?.content).toBe("vom dritten Actor");
    expect(gefragt.length).toBe(3);
    expect(gefragt[1].url).toContain("codepoetry~youtube-transcript-ai-scraper");
    expect(gefragt[2].url).toContain("supreme_coder~youtube-transcript-scraper");
  });

  test("behält die Metadaten des ersten Actors, der welche hatte", async () => {
    // Transkript und Metadaten müssen nicht vom selben Actor kommen. Ohne das
    // trüge das Dokument den Ersatztitel "YouTube Video <id>".
    fetchMit([
      [],
      OHNE_UNTERTITEL,
      [{ transcript_text: "Text ohne Metadaten", language: "de" }],
    ]);

    const r = await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws");

    expect(r.metadata?.title).toBe("Wie ernst ist die Lage?");
    expect(r.transcript?.content).toBe("Text ohne Metadaten");
  });

  test("der AI-Rückfall bleibt aus, solange er nicht eingeschaltet ist", async () => {
    // Er kostet KI-Minuten und kann in einem HTTP-Request nicht fertig
    // werden — deshalb aus, bis jemand ihn ausdrücklich will.
    delete process.env.APIFY_AI_FALLBACK;
    gefragt = fetchMit([[], OHNE_UNTERTITEL, [], []]);

    const r = await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws");

    expect(gefragt.length).toBe(4);
    expect(r.transcript).toBeNull();
    expect(r.metadata?.title).toBe("Wie ernst ist die Lage?");
  });

  test("eingeschaltet begrenzt er die KI-Minuten ausdrücklich", async () => {
    // Ohne eigene Grenze käme der Actor-Vorgabewert 30 Minuten zum Tragen
    // und würde ein längeres Video anfangen und mitten drin abbrechen —
    // bezahlt, ohne Ergebnis.
    process.env.APIFY_AI_FALLBACK = "1";
    process.env.APIFY_AI_MAX_MINUTES = "7";
    gefragt = fetchMit([
      [],
      OHNE_UNTERTITEL,
      [],
      [],
      [{ transcript_llm: "KI", language: "de", is_ai_generated: true }],
    ]);

    await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws");

    expect(gefragt[4].input.maxAiMinutes).toBe(7);
    expect(gefragt[4].input.skipAiFallbackIfLongerThan).toBe(7);
  });

  test("der AI-Rückfall geht an codepoetry, nicht an den ersten Actor", async () => {
    process.env.APIFY_AI_FALLBACK = "1";
    // `enableAiFallback` kennt nur codepoetry. Als Referenz auf
    // ACTOR_CHAIN[0] wäre der Rückfall nach dem Umstellen der Kette ein
    // zweiter, identischer und trotzdem berechneter Aufruf von johnvc.
    gefragt = fetchMit([
      [],
      OHNE_UNTERTITEL,
      [],
      [],
      [{ transcript_llm: "KI-Transkript", language: "de", is_ai_generated: true }],
    ]);

    const r = await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws");

    expect(gefragt.length).toBe(5);
    expect(gefragt[4].url).toContain("codepoetry~youtube-transcript-ai-scraper");
    expect(gefragt[4].input.enableAiFallback).toBe(true);
    expect(r.transcript?.source).toBe("ai_generated");
  });

  test("hört auf, sobald ein Transkript da ist", async () => {
    gefragt = fetchMit([JOHNVC, [{ transcript_text: "darf nicht gefragt werden" }]]);

    await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws");

    expect(gefragt.length).toBe(1);
  });

  test("gibt Metadaten auch zurück, wenn nichts ein Transkript hat", async () => {
    // Daran unterscheidet der Aufrufer ein Video ohne Untertitel von einem
    // Video, das gar nicht erreichbar war (dann ist auch metadata null).
    fetchMit([[], OHNE_UNTERTITEL, [], [], []]);

    const r = await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws");

    expect(r.transcript).toBeNull();
    expect(r.metadata?.title).toBe("Wie ernst ist die Lage?");
  });
});

describe("Feldauswahl der Rückfall-Actors", () => {
  /** Antwortform von scrape-creators, gekürzt aus dem echten Datensatz. */
  const SCRAPE_CREATORS = [
    {
      id: "NC6HhBQj4Ws",
      transcript_only_text: "Hello and a warm welcome, dear Daniele.",
      transcript: [
        { text: "Hello and a warm welcome, dear Daniele.", startMs: "399", endMs: "3759" },
        { text: "Thank you so very much for this book.", startMs: "3759", endMs: "7000" },
      ],
      language: "",
    },
  ];

  test("nimmt den Fließtext, nicht das Segment-Array", async () => {
    // Eine `||`-Kette hält das Array für Text. Im Dokument stand dann
    // "[object Object],[object Object],…" und `content.length` war die
    // Segmentzahl — eine Zeichenzahl, die plausibel aussieht.
    fetchMit([[], OHNE_UNTERTITEL, [], SCRAPE_CREATORS]);

    const r = await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws");

    expect(r.transcript?.content).toBe("Hello and a warm welcome, dear Daniele.");
    expect(r.transcript?.content).not.toContain("[object Object]");
    expect(r.transcript?.segments?.length).toBe(2);
  });

  test("ein Item ohne verwertbaren Text zählt nicht als Transkript", async () => {
    fetchMit([
      [],
      OHNE_UNTERTITEL,
      [],
      [{ id: "x", transcript: [{ text: "nur Segmente", startMs: "0" }] }],
      [],
    ]);

    const r = await new ApifyProvider("k").fetchVideoInfo("NC6HhBQj4Ws");

    expect(r.transcript).toBeNull();
  });
});
