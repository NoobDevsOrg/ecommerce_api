// middleware/upload.js

import multer from "multer";

const storage = multer.memoryStorage(); // store in memory (best for cloud upload)

export const upload = multer({ storage });