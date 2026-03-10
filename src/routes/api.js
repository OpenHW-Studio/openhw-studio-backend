import { Router } from "express";
import userRoutes from "./user.js";
import compileRoutes from "./compile.js";
import classroomRoutes from "./classroom.js";

const router = Router();

router.use("/user", userRoutes);
router.use("/compile", compileRoutes);
router.use("/classroom", classroomRoutes);

export default router;