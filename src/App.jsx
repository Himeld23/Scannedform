import React, { useState } from "react";
import Tesseract from "tesseract.js";

// PDF.js setup for Vite (ONLY WORKS with pdfjs-dist@3.9.179)
import * as pdfjsLib from "pdfjs-dist/build/pdf";
import workerSrc from "pdfjs-dist/build/pdf.worker.js?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

function App() {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]); // Stores all PDF results

  // MULTI-PAGE PDF → images[]
  const convertPdfToImages = async (file) => {
    try {
      const buffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

      const images = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({ canvasContext: ctx, viewport }).promise;

        images.push(canvas.toDataURL("image/png"));
      }

      return images; // array of png images
    } catch (err) {
      console.error("PDF → Image error:", err);
      return [];
    }
  };

  // Extract unknown fields dynamically
  const extractUnknownFields = (rawText) => {
    const lines = rawText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const extracted = {};

    for (let line of lines) {
      // Case 1: Key: Value
      const colonSplit = line.split(/[:\-]+/);
      if (colonSplit.length >= 2) {
        const key = colonSplit[0].trim();
        const value = colonSplit.slice(1).join(" ").trim();
        if (key && value) extracted[key] = value;
        continue;
      }

      // Case 2: Large spaces
      const spaced = line.split(/\s{3,}/);
      if (spaced.length === 2) {
        extracted[spaced[0].trim()] = spaced[1].trim();
        continue;
      }

      // Case 3: BP 120/80 type
      const tokens = line.split(/\s+/);
      if (tokens.length === 2) {
        const [key, value] = tokens;
        if (isNaN(key) && value) extracted[key] = value;
      }
    }

    return extracted;
  };

  // Handle multiple file uploads (multi-page aware)
  const handleFiles = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    setLoading(true);
    let allResults = [];

    for (const file of files) {
      let images = [];

      if (file.type === "application/pdf") {
        images = await convertPdfToImages(file); // ALL pages
      } else {
        images = [file]; // treat image as 1 page
      }

      if (images.length === 0) continue;

      let fullText = "";

      // OCR each page
      for (const img of images) {
        const worker = await Tesseract.createWorker("eng");
        const { data } = await worker.recognize(img);
        await worker.terminate();

        fullText += "\n" + data.text;
      }

      const extracted = extractUnknownFields(fullText);

      allResults.push({
        fileName: file.name,
        text: fullText,
        fields: extracted,
      });
    }

    setResults(allResults);
    setLoading(false);
  };

  // Download JSON for one file
  const downloadJSON = (fields, fileName) => {
    const blob = new Blob([JSON.stringify(fields, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = fileName + "_fields.json";
    a.click();

    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-5xl mx-auto p-6">
      <h1 className="text-3xl font-bold text-gray-800 mb-6">
        📄 Multi-PDF Automated Form Extraction (OCR — Multi Page)
      </h1>

      {/* MULTIPLE FILE UPLOAD */}
      <input
        type="file"
        accept="application/pdf,image/*"
        multiple
        onChange={handleFiles}
        className="w-full border p-2 rounded mb-4"
      />

      {loading && (
        <p className="text-blue-600 font-bold text-lg mt-4">
          Processing… ⏳
        </p>
      )}

      {/* SHOW EACH FILE RESULT */}
      {!loading && results.length > 0 && (
        <div className="mt-6 space-y-8">
          {results.map((res, i) => (
            <div key={i} className="bg-white border rounded p-5 shadow">
              <h2 className="text-xl font-bold mb-2">
                📄 File: {res.fileName}
              </h2>

              <h3 className="font-semibold mb-3">Extracted Fields</h3>

              {Object.entries(res.fields).map(([key, value], idx) => (
                <div key={idx} className="mb-3">
                  <label className="block font-medium">{key}</label>
                  <input
                    type="text"
                    className="w-full border rounded p-2"
                    value={value}
                    readOnly
                  />
                </div>
              ))}

              <button
                onClick={() => downloadJSON(res.fields, res.fileName)}
                className="mt-3 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
              >
                Download JSON
              </button>

              {/* OCR RAW TEXT */}
              <details className="mt-4">
                <summary className="cursor-pointer font-semibold">
                  Show Raw OCR Text
                </summary>
                <pre className="bg-gray-100 p-3 mt-2 rounded max-h-60 overflow-auto whitespace-pre-wrap">
                  {res.text}
                </pre>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
