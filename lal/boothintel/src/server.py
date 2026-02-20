from flask import Flask, request, jsonify
import subprocess
import os

app = Flask(__name__)

@app.route("/upload-electoral-roll", methods=["POST"])
def upload_file():
    file = request.files['file']
    path = "uploads/" + file.filename
    file.save(path)

    # Run your OCR + CSV script
    cmd = ["python3", "electoral_roll_pipeline.py", path, "--output-dir", "output"]
    subprocess.run(cmd)

    csv_file = "output/" + file.filename.split(".")[0] + "_voters.csv"

    if not os.path.exists(csv_file):
        return jsonify({"error": "OCR failed"}), 500

    return jsonify({"csv_path": csv_file})

if __name__ == "__main__":
    app.run(port=5001, debug=True)
