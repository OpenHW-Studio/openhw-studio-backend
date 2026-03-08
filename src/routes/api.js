import { Router } from "express";
import userRoutes from "./user.js";
import compileRoutes from "./compile.js";

const router = Router();

router.use("/user", userRoutes);
router.use("/compile", compileRoutes);

export default router;