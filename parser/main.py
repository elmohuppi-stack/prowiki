"""
MarkItDown Parser Microservice
API zum Parsen von PDF, DOCX, MD, HTML und TXT-Dateien.
"""

from flask import Flask, request, jsonify
import tempfile
import os

app = Flask(__name__)

try:
    from markitdown import MarkItDown

    md = MarkItDown()
except ImportError:
    md = None


@app.route("/parse", methods=["POST"])
def parse_document():
    if md is None:
        return jsonify({"error": "MarkItDown not installed"}), 500

    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file provided"}), 400

    ext = os.path.splitext(file.filename)[1].lower() if file.filename else ".txt"

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        file.save(tmp.name)
        tmp_path = tmp.name

    try:
        result = md.convert(tmp_path)
        return jsonify(
            {
                "content": result.text_content,
                "title": file.filename,
                "type": ext.lstrip("."),
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(tmp_path)


@app.route("/parse/text", methods=["POST"])
def parse_text():
    data = request.get_json()
    if not data or "content" not in data:
        return jsonify({"error": "No content provided"}), 400
    return jsonify(
        {
            "content": data["content"],
            "title": data.get("title", "Text"),
            "type": "text",
        }
    )


@app.route("/health", methods=["GET"])
def health():
    return jsonify(
        {
            "status": "ok",
            "markitdown_available": md is not None,
        }
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port)
