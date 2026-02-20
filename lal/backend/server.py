from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import os
from electoral_roll_pipeline import process_file

app = Flask(__name__)
CORS(app)
UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

@app.route("/upload-electoral-roll", methods=["POST"])
def upload_electoral_roll():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    filename = file.filename
    path = os.path.join(UPLOAD_DIR, filename)
    file.save(path)

    # Run OCR → JSON → CSV pipeline
    try:
        csv_path = process_file(path)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({
        "csv": os.path.basename(csv_path)
    })

@app.route("/get-csv/<filename>")
def get_csv(filename):
    return send_from_directory(UPLOAD_DIR, filename, mimetype="text/csv")

if __name__ == "__main__":
    app.run(port=5001, debug=True)
