#!/usr/bin/env python3
"""
WeKnora → Knora Export Script

Exportiert alle Knowledge Bases (Workspaces), Documents, Wiki-Pages und Chunks
aus WeKnora über die REST API und speichert sie als JSON-Dateien.

Verwendung:
  # Alle KBs exportieren
  python3 scripts/weknora-export.py --api-key <key> --url https://weknora.example.com/api/v1

  # Nur bestimmte KBs exportieren
  python3 scripts/weknora-export.py --api-key <key> --kb "Politik,Corona"

  # Nur Wiki-Pages (ohne Documents/Chunks)
  python3 scripts/weknora-export.py --api-key <key> --only wiki

Umgebungsvariablen:
  WEKNORA_API_KEY    – API-Key (alternativ zu --api-key)
  WEKNORA_BASE_URL   – Basis-URL (alternativ zu --url)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests


class WeKnoraExporter:
    """Exportiert Daten aus WeKnora via REST API."""

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update(
            {
                "X-API-Key": api_key,
                "Content-Type": "application/json",
            }
        )

    def _get(self, endpoint: str, params: dict = None) -> dict:
        url = f"{self.base_url}{endpoint}"
        resp = self.session.get(url, params=params, timeout=60)
        resp.raise_for_status()
        return resp.json()

    def _paginate(self, endpoint: str, page_size: int = 100) -> list:
        """Rufe eine paginierte API ab und sammle alle Ergebnisse."""
        all_items = []
        page = 1
        while True:
            data = self._get(endpoint, params={"page": page, "page_size": page_size})
            # Verschiedene Antwortformate unterstützen
            items = []
            if isinstance(data, list):
                items = data
            elif isinstance(data, dict):
                items = data.get(
                    "data", data.get("pages", data.get("list", data.get("items", [])))
                )
                if isinstance(items, dict) and "pages" in items:
                    items = items["pages"]

            if not items:
                break

            all_items.extend(items)
            page += 1

            # Prüfen ob es weitere Seiten gibt
            total = None
            if isinstance(data, dict):
                total = data.get("total", data.get("total_count"))
            if total is not None and len(all_items) >= total:
                break
            if len(items) < page_size:
                break

        return all_items

    def export_all(self, kb_filter: list = None, only: str = None) -> dict:
        """Exportiere alle Daten. Gibt Dict mit KB-Namen als Keys zurück."""
        result = {}

        print("📡 Lade Knowledge Bases...")
        kbs = self._paginate("/knowledge-bases")

        for kb in kbs:
            kb_id = kb.get("id") or kb.get("ID", "")
            kb_name = kb.get("name") or kb.get("Name", "Unknown")
            kb_slug = kb_name.lower().replace(" ", "-")

            if kb_filter and kb_name not in kb_filter:
                print(f"  ⏭️  Überspringe {kb_name}")
                continue

            print(f"\n{'='*50}")
            print(f"📂 Workspace: {kb_name} ({kb_id})")
            print(f"{'='*50}")

            kb_data = {
                "id": kb_id,
                "name": kb_name,
                "description": kb.get("description", ""),
                "slug": kb_slug,
                "type": kb.get("type", ""),
                "chunk_size": kb.get("chunk_size", 512),
                "chunk_overlap": kb.get("chunk_overlap", 50),
                "created_at": kb.get("created_at", ""),
                "updated_at": kb.get("updated_at", ""),
                "documents": [],
                "wiki_pages": [],
            }

            # Dokumente exportieren
            if only != "wiki":
                print(f"  📄 Lade Dokumente...")
                docs = self._paginate(f"/knowledge-bases/{kb_id}/knowledge")
                print(f"     → {len(docs)} Dokumente gefunden")

                for doc in docs:
                    doc_id = doc.get("id") or doc.get("ID", "")
                    doc_data = {
                        "id": doc_id,
                        "knowledge_base_id": kb_id,
                        "title": doc.get("title", doc.get("file_name", "")),
                        "type": doc.get("type", ""),
                        "source": doc.get("source", ""),
                        "source_url": doc.get("source_url", ""),
                        "file_name": doc.get("file_name", ""),
                        "file_type": doc.get("file_type", ""),
                        "file_size": doc.get("file_size", 0),
                        "parse_status": doc.get("parse_status", ""),
                        "content": doc.get("content", ""),
                        "description": doc.get("description", ""),
                        "channel": doc.get("channel", ""),
                        "metadata": doc.get("metadata", {}),
                        "created_at": doc.get("created_at", ""),
                        "updated_at": doc.get("updated_at", ""),
                    }

                    # YouTube-Metadaten aus metadata extrahieren
                    if doc_data["type"] == "youtube":
                        meta = doc_data["metadata"]
                        if isinstance(meta, str):
                            try:
                                meta = json.loads(meta)
                            except:
                                meta = {}
                        doc_data["youtube_info"] = {
                            "video_id": meta.get("youtube_video_id", ""),
                            "channel_name": meta.get("youtube_channel_name", ""),
                            "channel_url": meta.get("youtube_channel_url", ""),
                            "duration": meta.get("youtube_duration", 0),
                            "thumbnail_url": meta.get("youtube_thumbnail_url", ""),
                        }

                    kb_data["documents"].append(doc_data)

                # Details zu jedem Dokument abrufen (für Content)
                print(f"  📥 Lade Dokument-Details...")
                for i, doc in enumerate(kb_data["documents"]):
                    if doc["content"]:
                        continue  # Content bereits vorhanden
                    try:
                        detail = self._get(f"/knowledge/{doc['id']}")
                        if isinstance(detail, dict):
                            content = detail.get("data", detail)
                            if isinstance(content, dict):
                                kb_data["documents"][i]["content"] = content.get(
                                    "content", ""
                                )
                    except Exception as e:
                        print(f"     ⚠️  Detail-Fehler bei {doc['id']}: {e}")
                    time.sleep(0.05)  # Rate limiting

                print(f"     ✅ Details geladen")

            # Wiki-Seiten exportieren
            print(f"  📖 Lade Wiki-Seiten...")
            try:
                wiki_pages = self._paginate(f"/knowledgebase/{kb_id}/wiki/pages")
                print(f"     → {len(wiki_pages)} Wiki-Seiten gefunden")

                for wp in wiki_pages:
                    wp_data = {
                        "id": wp.get("id", ""),
                        "knowledge_base_id": kb_id,
                        "slug": wp.get("slug", ""),
                        "title": wp.get("title", ""),
                        "summary": wp.get("summary", ""),
                        "content": wp.get("content", ""),
                        "page_type": wp.get("page_type", ""),
                        "status": wp.get("status", "published"),
                        "out_links": wp.get("out_links", []),
                        "in_links": wp.get("in_links", []),
                        "aliases": wp.get("aliases", []),
                        "source_refs": wp.get("source_refs", []),
                        "chunk_refs": wp.get("chunk_refs", []),
                        "page_metadata": wp.get("page_metadata", {}),
                        "version": wp.get("version", 1),
                        "created_at": wp.get("created_at", ""),
                        "updated_at": wp.get("updated_at", ""),
                    }
                    kb_data["wiki_pages"].append(wp_data)

            except Exception as e:
                print(f"     ⚠️  Wiki-Fehler: {e}")

            result[kb_name] = kb_data
            print(
                f"  ✅ {kb_name}: {len(kb_data['documents'])} Docs, {len(kb_data['wiki_pages'])} Wiki-Seiten"
            )

        return result

    def save_to_disk(self, data: dict, output_dir: str):
        """Speichere exportierte Daten als JSON-Dateien."""
        base = Path(output_dir)
        base.mkdir(parents=True, exist_ok=True)

        for kb_name, kb_data in data.items():
            kb_slug = kb_data.get("slug", kb_name.lower().replace(" ", "-"))
            kb_dir = base / kb_slug
            kb_dir.mkdir(parents=True, exist_ok=True)

            # Workspace-Metadaten
            workspace_info = {
                "id": kb_data["id"],
                "name": kb_data["name"],
                "description": kb_data["description"],
                "slug": kb_slug,
                "type": kb_data.get("type", ""),
                "chunk_size": kb_data.get("chunk_size", 512),
                "chunk_overlap": kb_data.get("chunk_overlap", 50),
                "created_at": kb_data.get("created_at", ""),
                "updated_at": kb_data.get("updated_at", ""),
            }
            with open(kb_dir / "workspace.json", "w", encoding="utf-8") as f:
                json.dump(workspace_info, f, ensure_ascii=False, indent=2)
            print(f"  💾 {kb_dir}/workspace.json")

            # Dokumente
            if kb_data["documents"]:
                with open(kb_dir / "documents.json", "w", encoding="utf-8") as f:
                    json.dump(kb_data["documents"], f, ensure_ascii=False, indent=2)
                print(
                    f"  💾 {kb_dir}/documents.json ({len(kb_data['documents'])} Docs)"
                )

            # Wiki-Seiten
            if kb_data["wiki_pages"]:
                with open(kb_dir / "wiki-pages.json", "w", encoding="utf-8") as f:
                    json.dump(kb_data["wiki_pages"], f, ensure_ascii=False, indent=2)
                print(
                    f"  💾 {kb_dir}/wiki-pages.json ({len(kb_data['wiki_pages'])} Pages)"
                )

        # Gesamt-Index
        summary = []
        for kb_name, kb_data in data.items():
            summary.append(
                {
                    "name": kb_name,
                    "slug": kb_data.get("slug"),
                    "id": kb_data["id"],
                    "documents": len(kb_data["documents"]),
                    "wiki_pages": len(kb_data["wiki_pages"]),
                }
            )

        with open(base / "_index.json", "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)
        print(f"\n📊 Gesamt-Index: {base / '_index.json'}")
        print(f"   Workspaces: {len(summary)}")
        print(f"   Dokumente gesamt: {sum(s['documents'] for s in summary)}")
        print(f"   Wiki-Seiten gesamt: {sum(s['wiki_pages'] for s in summary)}")


def main():
    parser = argparse.ArgumentParser(description="WeKnora → Knora Export Script")
    parser.add_argument("--api-key", help="WeKnora API-Key")
    parser.add_argument(
        "--url",
        default="http://localhost:8080/api/v1",
        help="WeKnora API Base-URL (default: http://localhost:8080/api/v1)",
    )
    parser.add_argument(
        "--output",
        "-o",
        default="./exports",
        help="Output-Verzeichnis (default: ./exports)",
    )
    parser.add_argument("--kb", help="Nur bestimmte KBs exportieren (komma-getrennt)")
    parser.add_argument("--only", choices=["wiki"], help="Nur Wiki-Seiten exportieren")
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("WEKNORA_API_KEY")
    if not api_key:
        print("❌ Kein API-Key. Setze WEKNORA_API_KEY oder --api-key")
        sys.exit(1)

    kb_filter = [k.strip() for k in args.kb.split(",")] if args.kb else None

    print("🚀 WeKnora Export Script")
    print(f"   URL:    {args.url}")
    print(f"   Output: {args.output}")
    print(f"   Filter: {kb_filter or 'Alle KBs'}")

    exporter = WeKnoraExporter(args.url, api_key)
    data = exporter.export_all(kb_filter, args.only)
    exporter.save_to_disk(data, args.output)

    print(f"\n✅ Export abgeschlossen!")
    print(f"   → Daten in {args.output}/")


if __name__ == "__main__":
    main()
