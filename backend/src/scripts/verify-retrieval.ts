#!/usr/bin/env bun
/**
 * Verifiziert die RAG-Retrieval (wie sie der Chat nutzt) für jeden Workspace.
 * Ruft hybridSearch mit einer typischen Frage auf und zeigt, ob Dokument- UND
 * Wiki-Artikel-Chunks gefunden werden.
 */
import { db } from "../db/index.ts";
import { workspaces } from "../db/schema.ts";
import { inArray } from "drizzle-orm";
import { hybridSearch } from "../service/search.ts";

const QUERIES: Record<string, string> = {
  "RKI Files": "Was besprach der RKI-Krisenstab zur Maskenpflicht?",
  Politik: "Welche politischen Maßnahmen wurden diskutiert?",
  Corona: "Wie wirksam waren die Corona-Impfstoffe laut den Dokumenten?",
};

async function main() {
  const wss = await db
    .select()
    .from(workspaces)
    .where(inArray(workspaces.name, Object.keys(QUERIES)));
  for (const ws of wss.filter((w) => QUERIES[w.name])) {
    const q = QUERIES[ws.name];
    console.log(`\n${"=".repeat(60)}\n📂 ${ws.name}\n❓ ${q}`);
    const results = await hybridSearch(ws.id, q, 8);
    let docHits = 0;
    let wikiHits = 0;
    for (const r of results) {
      if (r.document_id.startsWith("wiki--")) wikiHits++;
      else docHits++;
    }
    console.log(
      `   → ${results.length} Treffer (${docHits} Dokument, ${wikiHits} Wiki-Artikel)`,
    );
    for (const r of results.slice(0, 4)) {
      const kind = r.document_id.startsWith("wiki--") ? "📖" : "📄";
      console.log(
        `   ${kind} [${r.search_type} ${r.score.toFixed(3)}] ${r.document_title}: ${r.content.slice(0, 70).replace(/\n/g, " ")}…`,
      );
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
