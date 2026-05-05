import fs from "fs";
import path from "path";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

async function toBase64Image(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const resp = await fetch(source);
    if (!resp.ok) throw new Error("Failed to fetch image");
    const contentType = resp.headers.get("content-type") || "image/png";
    const mediaType = contentType.split(";")[0].trim();
    const buffer = await resp.arrayBuffer();
    return { base64: Buffer.from(buffer).toString("base64"), mediaType };
  }
  const ext = path.extname(source).toLowerCase();
  const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
  const mediaType = mimeMap[ext] || "image/png";
  const buffer = await fs.promises.readFile(source);
  return { base64: buffer.toString("base64"), mediaType };
}

export async function gradeCircuitSubmission({
  referenceImageSource,
  studentImageSource,
  assignmentTitle = "Circuit Assignment",
  assignmentDesc = "",
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  try {
    const [refImg, studentImg] = await Promise.all([
      toBase64Image(referenceImageSource),
      toBase64Image(studentImageSource),
    ]);

    const requestBody = {
      contents: [{
        parts: [
          { text: "Compare the Teacher Reference and Student Submission. Return ONLY a JSON object: { \"score\": number, \"summary\": \"string\", \"errors\": [{\"component\": \"string\", \"description\": \"string\"}], \"suggestions\": [{\"area\": \"string\", \"tip\": \"string\"}] }" },
          { text: "REFERENCE IMAGE:" },
          { inline_data: { mime_type: refImg.mediaType, data: refImg.base64 } },
          { text: "STUDENT SUBMISSION:" },
          { inline_data: { mime_type: studentImg.mediaType, data: studentImg.base64 } }
        ]
      }]
    };

    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Gemini API Error: ${response.status} - ${errBody}`);
    }

    const responseData = await response.json();
    const rawText = responseData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    const cleanText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
    const rawParsed = JSON.parse(cleanText);

    let formattedErrors = [];
    if (Array.isArray(rawParsed.errors)) {
      formattedErrors = rawParsed.errors.map(err => {
        if (typeof err === "string") {
          return { component: "Circuit", description: err };
        }
        return {
          component: String(err.component || "Circuit"),
          description: String(err.description || "Issue identified")
        };
      });
    } else if (typeof rawParsed.errors === "string") {
      formattedErrors = [{ component: "Circuit", description: rawParsed.errors }];
    }

    return {
      score: Number(rawParsed.score) || 50,
      summary: String(rawParsed.summary || "Evaluation complete."),
      errors: formattedErrors,
      suggestions: Array.isArray(rawParsed.suggestions) ? rawParsed.suggestions : []
    };

  } catch (e) {
    return { 
      score: 0, 
      summary: `Grading failed: ${e.message}`, 
      errors: [{ component: "System", description: "Could not reach AI for grading." }], 
      suggestions: [] 
    };
  }
}