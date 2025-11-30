import React, { useState } from "react";
import Tesseract from "tesseract.js";
import * as pdfjsLib from "pdfjs-dist/build/pdf";
import workerSrc from "pdfjs-dist/build/pdf.worker.js?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;



function App() {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);

  const preprocessDataURL = async (dataUrl) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = dataUrl;
      img.onload = () => {
        const scale = 2; // upscale for OCR
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imageData.data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) {
          sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        }
        const avg = sum / (d.length / 4);
        const threshold = Math.max(120, Math.min(180, avg - 10));

        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          const v = lum < threshold ? 0 : 255;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = reject;
    });

  // ------------------ PDF  ------------------
  const convertPdfToImages = async (file) => {
    try {
      const buffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
      const images = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
        const rawDataUrl = canvas.toDataURL("image/png");
        const pre = await preprocessDataURL(rawDataUrl);
        images.push(pre);
      }
      return images;
    } catch (err) {
      console.error("PDF -> images error:", err);
      return [];
    }
  };

  // ------------------ OCR  ------------------
  const ocrImage = async (dataUrl) => {
    const worker = await Tesseract.createWorker("eng");
    const { data } = await worker.recognize(dataUrl);
    await worker.terminate();
    return data.text || "";
  };

  // ------------------ Helpers for parsing ------------------
  const normalizeText = (s = "") =>
    s
      .replace(/\r/g, "\n")
      .replace(/\t/g, " ")
      .replace(/\u00A0/g, " ")
      .replace(/[••]/g, ".")
      .replace(/[^\S\r\n]+/g, " ")
      .replace(/\.{2,}/g, " ... ")
      .trim();

  const splitLines = (text) =>
    text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);

  const extractByRegexList = (text, regexes) => {
    if (!text) return null;
    for (const r of regexes) {
      const m = text.match(r);
      if (m && m[1]) return m[1].trim();
    }
    return null;
  };

  const dotLeaderExtract = (text, label) => {
    if (!text) return null;
    const regex = new RegExp(label + "[\\s\\.\\:_-]{1,}([^\\n]{1,120})", "i");
    const m = text.match(regex);
    if (m && m[1]) return m[1].trim();
    // fallback: search lines and split on long dots or long spaces
    const lines = splitLines(text);
    for (const line of lines) {
      if (line.toLowerCase().includes(label.toLowerCase())) {
        const parts = line.split(/\.{3,}|\s{4,}/).map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
          if (parts[0].toLowerCase().includes(label.toLowerCase())) return parts[1];
          if (parts[1].toLowerCase().includes(label.toLowerCase())) return parts[0];
        }
      }
    }
    return null;
  };

  const twoColumnExtract = (text, label) => {
    if (!text) return null;
    const lines = splitLines(text);
    for (const line of lines) {
      const parts = line.split(/\.{3,}|\s{6,}/).map((p) => p.trim()).filter(Boolean);
      if (parts.length === 2) {
        if (parts[0].toLowerCase().includes(label.toLowerCase())) return parts[1];
        if (parts[1].toLowerCase().includes(label.toLowerCase())) return parts[0];
      }
    }
    return null;
  };

  // ------------------ Template detection ------------------
  const detectTemplate = (fullText) => {
    const low = fullText.toLowerCase();
    if (low.includes("handover sheet") || low.includes("handed over") || low.includes("patient condition")) {
      return "handover";
    }
    
    if (low.includes("relative") || low.includes("signature") || low.includes("uhid")) {
      return "consent";
    }
    return "unknown";
  };

  const parseHandover = (fullText) => {
    const text = normalizeText(fullText);
    const sections = {};
    const secSplit = text.split(/(?:\bI\s*\(Identification\)|\bIDENTIFICATION\b|\bS\s*\(Situation\)|\bSITUATION\b|\bB\s*\(Background\)|\bBACKGROUND\b|\bA\s*\(Assessment\)|\bASSESSMENT\b|\bR\s*\(Recommendation\)|\bRECOMMENDATION\b)/i).map(s => s.trim()).filter(Boolean);
    const full = text;

    const pick = (label, moreRegex = []) => {
      let v = dotLeaderExtract(full, label);
      if (v) return v;
      v = twoColumnExtract(full, label);
      if (v) return v;
      v = extractByRegexList(full, moreRegex);
      if (v) return v;
      return null;
    };

    const out = {};
    out.patient_name = pick("Patient Name", [/Patient\s*Name[:\.\s\-]*([A-Za-z0-9\s,.'\-\/]+)/i]);
    out.uhid = pick("UHID", [/UHID[^:\n]*[:\s]*([A-Za-z0-9\-\/]+)/i, /UHID\s*No[^:\n]*[:\s]*([A-Za-z0-9\-\/]+)/i]);
    out.date_of_admission = pick("Date of Admission", [/Date\s*of\s*Admission[:\s]*([A-Za-z0-9\/\-\: ]{3,30})/i]);
    out.date_of_surgery = pick("Date of Surgery", [/Date\s*of\s*Surgery[:\s]*([A-Za-z0-9\/\-\: ]{3,30})/i]);
    out.time = pick("Time", [/Time[:\s]*([0-2]?[0-9]:?[0-5]?[0-9]?)/i]);
    out.age = pick("Age", [/Age[:\s]*([0-9]{1,3})/i]);
    out.surgery_name = pick("Surgery Name", [/Surgery\s*Name[:\s]*(.+?)(?:\n|$)/i]);

    out.patient_condition = pick("Patient Condition", [/Patient\s*Condition[:\s]*(.+?)(?:\n|$)/i]) || (full.toLowerCase().includes("conscious") ? "Conscious / Oriented" : null);

    out.allergies = pick("Allergies", [/Allerg(?:y|ies)[^:\n]*[:\s]*([^,\n]+)/i, /If any[^:\n]*[:\s]*([^,\n]+)/i]);

    out.diabetic_diet = pick("Diabetic|Diet", [/Diabetic[^:\n]*[:\s]*([A-Za-z0-9\/\s]+)/i, /Diet[:\s]*([A-Za-z0-9\/\s]+)/i]);

    out.medication_given = pick("Medication Given", [/Medication\s*Given[:\s]*([^,\n]+)/i]);

    const vitals = {};
    vitals.bp = extractByRegexList(full, [/(?:BP|Blood Pressure)[^\d]*(\d{2,3}\/\d{2,3})/i, /(BP)[:\s]*([0-9]{2,3}\/[0-9]{2,3})/i]) || extractByRegexList(full, [/BP[:\s]*([^,\n]+)/i]);
    vitals.pulse = extractByRegexList(full, [/Pulse[:\s]*([0-9]{2,3})/i, /PR[:\s]*([0-9]{2,3})/i]);
    vitals.temperature = extractByRegexList(full, [/Temp(?:erature)?[:\s]*([0-9]{2,3}\.?[0-9]?)/i]);
    vitals.rr = extractByRegexList(full, [/RR[:\s]*([0-9]{2,3})/i, /Respiratory Rate[:\s]*([0-9]{1,3})/i]);
    vitals.spo2 = extractByRegexList(full, [/SPO2[:\s]*([0-9]{2,3})%?/i, /SpO2[:\s]*([0-9]{2,3})/i]);

    out.vitals = vitals;

    out.foleys_catheter = pick("Foleys Catheter", [/Foley(?:s)?\s*Catheter[:\s]*([A-Za-z0-9\/\s]+)/i]);
    out.iv_fluids = pick("IV Fluids", [/IV\s*Fluids[:\s]*([A-Za-z0-9\/\s]+)/i]);
    out.blood_transfusion = pick("Blood Transfusion", [/Blood\s*Transfusion[:\s]*([A-Za-z0-9\/\s]+)/i]);
    out.wound_site = pick("Wound Site", [/Wound\s*Site[:\s]*([A-Za-z0-9\/\s]+)/i]);
    out.recommendation = pick("Recommendation", [/Recommendation[s]?:[:\s]*([A-Za-z0-9\-\.,\/\s]+)/i, /Any changes\s*\/\s*plan in the treatment[:\s]*([A-Za-z0-9\-\.,\/\s]+)/i]);

    return out;
  };

  const parseConsent = (fullText) => {
    const text = normalizeText(fullText);
    const lines = splitLines(text);

    const out = {};
    out.patient_name = extractByRegexList(text, [
      /Patient\s*Name[:\.\s\-_]{1,}([A-Za-z0-9\s,'\-\/]+)/i,
      /Name[:\s]{1,}([A-Za-z0-9\s,'\-\/]+)/i,
    ]);

    if (!out.patient_name) {
      for (const l of lines) {
        if (l.split(" ").length >= 2 && /[A-Za-z]/.test(l) && l.length < 60 && !l.toLowerCase().includes("patient")) {
          out.patient_name = l;
          break;
        }
      }
    }

    out.relative_name = extractByRegexList(text, [/Relative(?:'s)?\s*Name[:\s]*([A-Za-z0-9\s,'\-\/]+)/i, /Relative[:\s]*([A-Za-z0-9\s,'\-\/]+)/i]);
    out.relative_contact = extractByRegexList(text, [/Contact(?:\s*No\.?| number)?[:\s]*([0-9\-\+\s]{6,})/i, /Contact\s*No[:\s]*([0-9\-\+\s]{6,})/i]);
    out.signature = extractByRegexList(text, [/Signature[:\s]*([A-Za-z0-9\s,'\-\/]+)/i]); // sometimes signature text isn't useful
    out.uhid = extractByRegexList(text, [/UHID[^:\n]*[:\s]*([A-Za-z0-9\-\/]+)/i, /UHID\s*No[:\s]*([A-Za-z0-9\-\/]+)/i]);
    out.date = extractByRegexList(text, [/Date[:\s]*([0-3]?\d[\/\-\.\s][0-1]?\d[\/\-\.\s][0-9]{2,4})/i, /Date\s*of\s*Admission[:\s]*([A-Za-z0-9\/\-\s]+)/i]);
    out.weight = extractByRegexList(text, [/Weight[:\s]*([0-9]{2,3}\.?[0-9]?)/i]);
    out.bmi = extractByRegexList(text, [/BMI[:\s]*([0-9]{1,3}\.?[0-9]?)/i]);
    out.pulse = extractByRegexList(text, [/Pulse[:\s]*([0-9]{2,3})/i]);
    out.bp = extractByRegexList(text, [/(?:BP|Blood Pressure)[:\s]*([0-9]{2,3}\/[0-9]{2,3})/i]);
    out.temp = extractByRegexList(text, [/Temp(?:erature)?[:\s]*([0-9]{2,3}\.?[0-9]?)/i]);
    out.rr = extractByRegexList(text, [/RR[:\s]*([0-9]{1,3})/i]);
    out.spo2 = extractByRegexList(text, [/SPO2[:\s]*([0-9]{2,3})%?/i]);
    out.diagnosis = extractByRegexList(text, [/Diagnosis[:\s]*([A-Za-z0-9\,\s\-\(\)\/]+)/i, /Provisional Diagnosis[:\s]*([A-Za-z0-9\,\s\-\(\)\/]+)/i]);
    out.treatment = extractByRegexList(text, [/Treatment[:\s]*([A-Za-z0-9\,\-\s]+)/i, /Plan[:\s]*([A-Za-z0-9\,\-\s]+)/i]);

    return out;
  };

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setLoading(true);
    const outResults = [];

    for (const file of files) {
      try {
        let images = [];
        if (file.type === "application/pdf") {
          images = await convertPdfToImages(file);
        } else {
          const dataUrl = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = rej;
            fr.readAsDataURL(file);
          });
          const pre = await preprocessDataURL(dataUrl);
          images = [pre];
        }
        if (!images.length) {
          outResults.push({ fileName: file.name, error: "no images" });
          continue;
        }

        let fullText = "";
        for (const img of images) {
          const pageText = await ocrImage(img);
          fullText += "\n" + (pageText || "");
        }
        fullText = normalizeText(fullText);

        const template = detectTemplate(fullText);

        let fields = {};
        if (template === "handover") {
          fields = parseHandover(fullText);
        } else if (template === "consent") {
          fields = parseConsent(fullText);
        } else {
          fields = { handover: parseHandover(fullText), consent: parseConsent(fullText) };
        }

        outResults.push({
          fileName: file.name,
          template,
          fields,
          text: fullText,
        });
      } catch (err) {
        console.error("file processing error", file.name, err);
        outResults.push({ fileName: file.name, error: String(err) });
      }
    }

    setResults(outResults);
    setLoading(false);
  };

  // ------------------ Download JSON ------------------
  const downloadJSON = (fields, fileName) => {
    const blob = new Blob([JSON.stringify(fields, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName + "_fields.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  // ------------------ UI ------------------
  return (
    <div style={{ maxWidth: 980, margin: "18px auto", padding: 20, fontFamily: "system-ui, Arial" }}>
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>📄 Scanned Medical Forms — Auto-detect & Extract</h1>

      <input type="file" accept="application/pdf,image/*" multiple onChange={handleFiles} style={{ width: "100%", padding: 8, marginBottom: 12 }} />

      {loading && <div style={{ color: "#0b63d6", marginBottom: 12 }}>Processing… ⏳ (this can take a bit for multiple pages)</div>}

      {!loading && results.length === 0 && <div style={{ color: "#555" }}>Upload your PDFs (same hospital templates) to extract structured fields.</div>}

      <div style={{ marginTop: 12, display: "grid", gap: 16 }}>
        {results.map((res, idx) => (
          <div key={idx} style={{ padding: 12, borderRadius: 6, border: "1px solid #ddd", background: "#fff" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>📄 {res.fileName}</strong>
                <div style={{ fontSize: 12, color: "#666" }}>Template: {res.template || "unknown"}</div>
              </div>
              <div>
                <button onClick={() => downloadJSON(res.fields, res.fileName)} style={{ background: "#2563eb", color: "#fff", padding: "6px 10px", borderRadius: 6, border: "none", cursor: "pointer" }}>
                  Download JSON
                </button>
              </div>
            </div>

            {res.error && <div style={{ marginTop: 8, color: "crimson" }}>Error: {res.error}</div>}

            {!res.error && (
              <>
                <div style={{ marginTop: 10 }}>
                  <strong>Extracted Fields</strong>
                  <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {Object.entries(res.fields).length === 0 && <div style={{ gridColumn: "1 / -1", color: "#666" }}>No fields found — try adjusting scans or upload another sample.</div>}
                    {Object.entries(res.fields).map(([k, v]) => (
                      <div key={k}>
                        <div style={{ fontSize: 12, color: "#444", marginBottom: 4 }}>{k.replace(/_/g, " ")}</div>
                        <input readOnly value={typeof v === "object" ? JSON.stringify(v) : v || ""} style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #ddd" }} />
                      </div>
                    ))}
                  </div>
                </div>

                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: "pointer" }}>Show Raw OCR Text</summary>
                  <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 10, borderRadius: 6, maxHeight: 300, overflow: "auto" }}>{res.text}</pre>
                </details>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
