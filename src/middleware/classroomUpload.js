import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const classroomAssetsRoot = path.resolve(
  __dirname,
  "../../../OpenHW-studio-frontend/public/assets/classroom",
);

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const sanitizeSegment = (value, fallback) =>
  (value || fallback)
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || fallback;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const category = sanitizeSegment(req.body?.category, "misc");
    const classId = sanitizeSegment(req.body?.classId, "shared");
    const destinationDir = path.join(classroomAssetsRoot, category, classId);

    ensureDir(destinationDir);
    cb(null, destinationDir);
  },
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    const baseName = path.basename(file.originalname || "upload", extension);
    const safeBaseName = sanitizeSegment(baseName, "upload");
    cb(null, `${Date.now()}-${safeBaseName}${extension}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/svg+xml",
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
    return;
  }

  cb(new Error("Only PDF and image files are supported."));
};

export const classroomUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 10,
  },
});

export const getClassroomAssetPublicPath = (filePath) => {
  const relativePath = path.relative(classroomAssetsRoot, filePath).replace(/\\/g, "/");
  return `/assets/classroom/${relativePath}`;
};

export const getClassroomAssetsRoot = () => classroomAssetsRoot;
