BoothIntel : Advanced Electoral Roll Intelligence & Household Analysis System
Web Stack / Requirements

* **React.js (Frontend)**
* **Flask (Python Backend)**
* **Tesseract OCR (English + Tamil)**
* **Poppler (PDF Rendering)**
* **Python Modules:**
  `pdf2image`, `pdfplumber`, `pytesseract`, `pandas`, `openpyxl`
* **CSV / JSON Export Support**

---

## Functionalities

* **OCR-powered extraction (English & Tamil PDFs)**
* **Automatic parsing of:**

  * Name
  * Relation Type (S/O, D/O, W/O, etc.)
  * Relation Name
  * House Number
  * Age & Gender
  * EPIC (Voter ID)
  * Section, Part Number & Page
* **Household clustering**
* **Family tree reconstruction (parent-child, spouse links)**
* **Suspicious household flagging**
* **Dashboard to view households & voters**
* **Visit/Follow-Up status tracking**
* **Debug exports:**

  * Raw OCR dump
  * debug_raw.csv
  * debug_clean.csv
  * debug_clean.xlsx
  * debug.json

---

## Instructions

### 1. Install the full repository

* Download the ZIP and extract
  **OR**
* Clone the repository

```bash
git clone https://github.com/Rohit2407/Boothintel.git
```

---

### 2. Install required dependencies

Backend:

```bash
pip install flask pdf2image pytesseract pdfplumber pandas openpyxl
```

---

### 3. Install OCR tools (Required)

#### Install **Tesseract**

Windows:

```bash
choco install tesseract
```

Make sure languages **eng** and **tam** are installed.

#### Install **Poppler**

```bash
choco install poppler
```

---

### 4. Start the backend server

Inside the **backend/** directory:

```bash
python server.py
```

If successful, Flask runs at:

```
http://localhost:5001
```

---

### 5. Start the frontend

Inside the **frontend/** directory:

```bash
npm install
npm run dev
```

Your web app is now available at:

```
http://localhost:5173
```

---

### 6. Using from mobile

1. Find your computer’s IPv4 (cmd → `ipconfig`)
2. Replace localhost with your IP in `BACKEND_URL` inside frontend
3. Connect both laptop + phone to same Wi-Fi
4. App works on phone and laptop

---

## About the Project

**BoothIntel** is a full-stack electoral roll analysis system built by **Rohit Raj** for booth-level voter intelligence and household mapping.
It was designed to solve real-world data extraction problems from Tamil Nadu electoral roll PDFs, which often contain a mix of English & Tamil text.

The system automatically:

* Converts PDFs → text using OCR
* Structures voter data
* Groups people into households
* Detects suspicious entries
* Allows ground volunteers to track household visits



---

## Authors

* **Rohit Raj**

---

